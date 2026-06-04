'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { getBrowser, closeBrowser, createContext, blockResources } = require('./browser');

const CHUNK_CHARS = 150_000;       // ~50 pages at 3000 chars/page — split on char count
const MAX_RETRIES = 2;
const CONCURRENCY = Math.min(4, Math.max(2, Math.floor(os.cpus().length * 1.5)));
const RESTART_EVERY = 20;
const CHUNK_PAGE_THRESHOLD = 1000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML-safe splitting ────────────────────────────────────────────────────────
// Splits body content at a tag boundary so we never cut inside an element.
function splitBodySafe(body, targetChars) {
  const chunks = [];
  let pos = 0;

  while (pos < body.length) {
    let end = pos + targetChars;
    if (end >= body.length) {
      chunks.push(body.slice(pos));
      break;
    }
    // Walk forward until we're not inside a tag (next '<' at start of a tag boundary)
    // Walk back to find the last '>' before the cut point — safe tag boundary
    let safe = body.lastIndexOf('>', end);
    if (safe <= pos) safe = end; // no tag found, cut anyway
    chunks.push(body.slice(pos, safe + 1));
    pos = safe + 1;
  }

  return chunks.filter(c => c.trim());
}

function extractHead(htmlContent) {
  const m = htmlContent.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function extractBody(htmlContent) {
  const m = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : htmlContent; // fallback: treat whole file as body
}

function wrapChunk(bodyChunk, head) {
  return `<!DOCTYPE html><html><head>${head}</head><body>${bodyChunk}</body></html>`;
}

// ── Temp file helpers ──────────────────────────────────────────────────────────
function writeChunkFiles(bodyChunks, head) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
  const paths = bodyChunks.map((chunk, i) => {
    const p = path.join(tmpDir, `chunk-${String(i).padStart(5, '0')}.html`);
    fs.writeFileSync(p, wrapChunk(chunk, head), 'utf8');
    return p;
  });
  return { tmpDir, paths };
}

function cleanupTmpDir(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Rendering ──────────────────────────────────────────────────────────────────
async function renderFile(tmpPath, options = {}) {
  const {
    format = 'A4',
    margin = { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    printBackground = true,
    displayHeaderFooter = false,
  } = options;

  const browser = await getBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();
  await page.setDefaultTimeout(120000);
  await blockResources(page);

  try {
    await page.goto(`file://${tmpPath}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(150);
    return await page.pdf({ format, margin, printBackground, displayHeaderFooter });
  } finally {
    await page.close();
    await context.close();
  }
}

// If printToPDF fails, split the chunk in half and render each half recursively.
async function renderWithFallback(tmpPath, options, depth = 0) {
  try {
    return await renderFile(tmpPath, options);
  } catch (err) {
    const isPrintFail = /printToPDF|Printing failed/i.test(err.message);
    const isCrash    = /closed|crashed|disconnected|Target page/i.test(err.message);

    if (isCrash) await closeBrowser();

    // Recursively halve the chunk (max 3 levels = 1/8th original size)
    if (isPrintFail && depth < 3) {
      const html = fs.readFileSync(tmpPath, 'utf8');
      const head = extractHead(html);
      const body = extractBody(html);
      const mid = Math.floor(body.length / 2);
      // Find safe split point (tag boundary)
      const safeMid = body.lastIndexOf('>', mid);
      const half = safeMid > 0 ? safeMid + 1 : mid;

      const tmpDir = path.dirname(tmpPath);
      const base   = path.basename(tmpPath, '.html');
      const pathA  = path.join(tmpDir, `${base}-a${depth}.html`);
      const pathB  = path.join(tmpDir, `${base}-b${depth}.html`);

      fs.writeFileSync(pathA, wrapChunk(body.slice(0, half), head), 'utf8');
      fs.writeFileSync(pathB, wrapChunk(body.slice(half),    head), 'utf8');

      const [bufA, bufB] = await Promise.all([
        renderWithFallback(pathA, options, depth + 1),
        renderWithFallback(pathB, options, depth + 1),
      ]);

      // Merge the two halves into one buffer
      const merged = await PDFDocument.create();
      for (const buf of [bufA, bufB]) {
        const doc = await PDFDocument.load(buf);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      }
      return Buffer.from(await merged.save());
    }

    if (MAX_RETRIES > 1) {
      await sleep(1500);
      return renderFile(tmpPath, options); // one plain retry
    }
    throw err;
  }
}

// ── PDF helpers ────────────────────────────────────────────────────────────────
async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

async function streamMerge(mergedDoc, pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer);
  const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
  pages.forEach(p => mergedDoc.addPage(p));
}

// ── Main entry ─────────────────────────────────────────────────────────────────
async function generatePdf(htmlContent, options = {}, progress = null) {
  const estimatedPages = Math.ceil(htmlContent.length / 3000);

  if (estimatedPages < CHUNK_PAGE_THRESHOLD) {
    if (progress) progress.log('Single render (small document)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
    const tmpPath = path.join(tmpDir, 'doc.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');
    try {
      const buffer = await renderWithFallback(tmpPath, options);
      const pages  = await countPdfPages(buffer);
      return { buffer, pages, chunks: 1 };
    } finally {
      cleanupTmpDir(tmpDir);
    }
  }

  // Large document: split body at tag boundaries → temp files → parallel render
  const head        = extractHead(htmlContent);
  const body        = extractBody(htmlContent);
  const bodyChunks  = splitBodySafe(body, CHUNK_CHARS);

  if (progress) {
    progress.total = bodyChunks.length;
    progress.log(`${bodyChunks.length} chunks  concurrency=${CONCURRENCY}  writing temp files...`);
  }

  const { tmpDir, paths } = writeChunkFiles(bodyChunks, head);
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
      pdfParts[nextMerge] = null; // free buffer immediately
      nextMerge++;
    }
    lock.merging = false;
  }

  async function worker() {
    let localCount = 0;
    while (true) {
      const i = renderIdx++;
      if (i >= paths.length) break;

      if (localCount > 0 && localCount % RESTART_EVERY === 0) {
        await closeBrowser();
        await sleep(300);
      }

      pdfParts[i] = await renderWithFallback(paths[i], options);
      localCount++;

      if (progress) progress.tick();
      await flushMerge();
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await flushMerge();
  } finally {
    cleanupTmpDir(tmpDir);
    await closeBrowser();
  }

  const buffer = Buffer.from(await mergedDoc.save());
  const pages  = await countPdfPages(buffer);
  return { buffer, pages, chunks: bodyChunks.length };
}

module.exports = { generatePdf };
