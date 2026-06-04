'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { getBrowser, closeBrowser, closeAllBrowsers, createContext, blockResources } = require('./browser');

const CHUNK_CHARS = 150_000;
const MAX_RETRIES = 2;
const CONCURRENCY = Math.min(3, Math.max(1, Math.floor(os.cpus().length / 2)));
const RESTART_EVERY = 15;
const CHUNK_PAGE_THRESHOLD = 1000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML helpers ───────────────────────────────────────────────────────────────
function extractHead(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function extractBody(html) {
  const m = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  // Return both the body attributes and inner content
  return m ? { attrs: m[1], content: m[2] } : { attrs: '', content: html };
}

function splitBodySafe(body, targetChars) {
  const chunks = [];
  let pos = 0;
  while (pos < body.length) {
    let end = pos + targetChars;
    if (end >= body.length) { chunks.push(body.slice(pos)); break; }
    const safe = body.lastIndexOf('>', end);
    const cut = safe > pos ? safe + 1 : end;
    chunks.push(body.slice(pos, cut));
    pos = cut;
  }
  return chunks.filter(c => c.trim());
}

function wrapChunk(bodyChunk, head, bodyAttrs = '') {
  return `<!DOCTYPE html><html><head>${head}</head><body${bodyAttrs}>${bodyChunk}</body></html>`;
}

// ── Temp file helpers ──────────────────────────────────────────────────────────
function writeChunkFiles(bodyChunks, head, bodyAttrs = '') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
  const paths = bodyChunks.map((chunk, i) => {
    const p = path.join(tmpDir, `chunk-${String(i).padStart(5, '0')}.html`);
    fs.writeFileSync(p, wrapChunk(chunk, head, bodyAttrs), 'utf8');
    return p;
  });
  return { tmpDir, paths };
}

function cleanupTmpDir(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Rendering (per-worker browser) ────────────────────────────────────────────
async function renderFile(tmpPath, options, workerId) {
  const {
    format = 'A4',
    margin = { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    printBackground = true,
    displayHeaderFooter = false,
  } = options;

  const browser = await getBrowser(workerId);
  const context = await createContext(browser);
  const page    = await context.newPage();
  await page.setDefaultTimeout(120000);
  await blockResources(page);

  try {
    await page.goto(`file://${tmpPath}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(300); // let web fonts & CSS transitions settle
    return await page.pdf({ format, margin, printBackground, displayHeaderFooter });
  } finally {
    try { await page.close();    } catch (_) {}
    try { await context.close(); } catch (_) {}
  }
}

// On printToPDF failure: split chunk in half and render each half, then merge
async function renderWithFallback(tmpPath, options, workerId, depth = 0) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await renderFile(tmpPath, options, workerId);
    } catch (err) {
      const isPrintFail = /printToPDF|Printing failed/i.test(err.message);
      const isCrash     = /closed|crashed|disconnected|Target page/i.test(err.message);

      if (isCrash) {
        await closeBrowser(workerId);
        await sleep(500 * attempt);
      }

      // On print failure: recursively halve (max depth 3 = 1/8th original)
      if (isPrintFail && depth < 3) {
        const html = fs.readFileSync(tmpPath, 'utf8');
        const head = extractHead(html);
        const { attrs: bodyAttrs, content: body } = extractBody(html);
        const mid  = body.lastIndexOf('>', Math.floor(body.length / 2));
        const cut  = mid > 0 ? mid + 1 : Math.floor(body.length / 2);

        const dir   = path.dirname(tmpPath);
        const base  = path.basename(tmpPath, '.html');
        const pathA = path.join(dir, `${base}-a${depth}.html`);
        const pathB = path.join(dir, `${base}-b${depth}.html`);
        fs.writeFileSync(pathA, wrapChunk(body.slice(0, cut), head, bodyAttrs), 'utf8');
        fs.writeFileSync(pathB, wrapChunk(body.slice(cut),    head, bodyAttrs), 'utf8');

        const [bufA, bufB] = await Promise.all([
          renderWithFallback(pathA, options, workerId, depth + 1),
          renderWithFallback(pathB, options, workerId, depth + 1),
        ]);
        const merged = await PDFDocument.create();
        for (const buf of [bufA, bufB]) {
          const doc   = await PDFDocument.load(buf);
          const pages = await merged.copyPages(doc, doc.getPageIndices());
          pages.forEach(p => merged.addPage(p));
        }
        return Buffer.from(await merged.save());
      }

      if (attempt === MAX_RETRIES) throw err;
      await sleep(1000 * attempt);
    }
  }
}

// ── PDF merge helpers ──────────────────────────────────────────────────────────
async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

async function streamMerge(mergedDoc, pdfBuffer) {
  const doc   = await PDFDocument.load(pdfBuffer);
  const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
  pages.forEach(p => mergedDoc.addPage(p));
}

// ── Main entry ─────────────────────────────────────────────────────────────────
async function generatePdf(htmlContent, options = {}, progress = null) {
  const estimatedPages = Math.ceil(htmlContent.length / 3000);

  if (estimatedPages < CHUNK_PAGE_THRESHOLD) {
    if (progress) progress.log('Single render (small document)');
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
    const tmpPath = path.join(tmpDir, 'doc.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');
    try {
      const buffer = await renderWithFallback(tmpPath, options, 'w0');
      const pages  = await countPdfPages(buffer);
      return { buffer, pages, chunks: 1 };
    } finally {
      cleanupTmpDir(tmpDir);
      await closeAllBrowsers();
    }
  }

  // Large document
  const head                        = extractHead(htmlContent);
  const { attrs: bodyAttrs, content: body } = extractBody(htmlContent);
  const bodyChunks                  = splitBodySafe(body, CHUNK_CHARS);

  if (progress) {
    progress.total = bodyChunks.length;
    progress.log(`${bodyChunks.length} chunks  concurrency=${CONCURRENCY}  writing temp files...`);
  }

  const { tmpDir, paths } = writeChunkFiles(bodyChunks, head, bodyAttrs);
  if (progress) progress.log('Rendering chunks...');

  const mergedDoc = await PDFDocument.create();
  const pdfParts  = new Array(bodyChunks.length);
  let nextMerge   = 0;
  let renderIdx   = 0;
  const lock      = { merging: false };

  async function flushMerge() {
    if (lock.merging) return;
    lock.merging = true;
    while (nextMerge < pdfParts.length && pdfParts[nextMerge] !== undefined) {
      await streamMerge(mergedDoc, pdfParts[nextMerge]);
      pdfParts[nextMerge] = null;
      nextMerge++;
    }
    lock.merging = false;
  }

  async function worker(workerId) {
    const wid = `w${workerId}`;
    let localCount = 0;
    while (true) {
      const i = renderIdx++;
      if (i >= paths.length) break;

      // Restart this worker's browser periodically to reclaim memory
      if (localCount > 0 && localCount % RESTART_EVERY === 0) {
        await closeBrowser(wid);
        await sleep(300);
      }

      try {
        pdfParts[i] = await renderWithFallback(paths[i], options, wid);
      } catch (err) {
        // Last-resort: emit a blank page so merge isn't blocked
        if (progress) progress.log(`  chunk ${i} failed permanently: ${err.message.slice(0, 80)}`);
        const blank = await PDFDocument.create();
        blank.addPage();
        pdfParts[i] = Buffer.from(await blank.save());
      }

      localCount++;
      if (progress) progress.tick();
      await flushMerge();
    }
    await closeBrowser(wid);
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => worker(id)));
    await flushMerge();
  } finally {
    cleanupTmpDir(tmpDir);
    await closeAllBrowsers();
  }

  const buffer = Buffer.from(await mergedDoc.save());
  const pages  = await countPdfPages(buffer);
  return { buffer, pages, chunks: bodyChunks.length };
}

module.exports = { generatePdf };
