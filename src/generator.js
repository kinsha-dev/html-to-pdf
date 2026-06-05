'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { blockResources } = require('./browser');
const { pool: browserPool } = require('./browser-pool');

const CHARS_PER_PAGE       = 3000;
const CHUNK_PAGE_MIN       = parseInt(process.env.CHUNK_PAGES || '200'); // 200 pages per chunk
const CHUNK_CHARS          = CHARS_PER_PAGE * CHUNK_PAGE_MIN; // 600,000 chars default
const MAX_RETRIES          = 2;
const CONCURRENCY          = parseInt(process.env.RENDER_CONCURRENCY || '1'); // 1 = no OOM under load
const CHUNK_PAGE_THRESHOLD = 1000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML helpers ───────────────────────────────────────────────────────────────
function extractHead(html) {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}

function extractBody(html) {
  const m = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  if (m) return { attrs: m[1], content: m[2] };
  const h = html.match(/<html[^>]*>([\s\S]*?)<\/html>/i);
  if (h) {
    const inner = h[1].replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
    return { attrs: '', content: inner };
  }
  return { attrs: '', content: html };
}

const LAYOUT_TAG_RE = /<(p|div|br|hr|table|tr|td|th|ul|ol|li|h[1-6]|pre|code|blockquote|center|section|article|header|footer|nav|aside|form|input|textarea|button)\b/i;
const HAS_STYLE_RE  = /<style[\s>]|<link[^>]+stylesheet/i;

function isSparseHtml(html) {
  const { content } = extractBody(html);
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
  return !LAYOUT_TAG_RE.test(stripped) && !HAS_STYLE_RE.test(html);
}

const SPARSE_STYLE = `<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #fff; color: #000; }
  pre {
    font-family: 'Courier New', Courier, monospace;
    font-size: 11pt;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    word-break: break-word;
    padding: 16px 24px;
    margin: 0;
  }
  @media print {
    pre { font-family: 'Courier New', Courier, monospace; font-size: 11pt;
          line-height: 1.6; white-space: pre-wrap; }
  }
</style>`;

function escapeSparse(text) {
  return text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;b&gt;/gi, '<b>').replace(/&lt;\/b&gt;/gi, '</b>')
    .replace(/&lt;i&gt;/gi, '<i>').replace(/&lt;\/i&gt;/gi, '</i>');
}

function normalizeSparseHtml(html) {
  const head = extractHead(html);
  const { attrs, content } = extractBody(html);
  return `<!DOCTYPE html><html><head>${head}${SPARSE_STYLE}</head><body${attrs}><pre>${escapeSparse(content)}</pre></body></html>`;
}

function splitTextChunks(text, targetChars) {
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = pos + targetChars;
    if (end >= text.length) { chunks.push(text.slice(pos)); break; }
    const nl = text.lastIndexOf('\n', end);
    const cut = nl > pos ? nl + 1 : end;
    chunks.push(text.slice(pos, cut));
    pos = cut;
  }
  return chunks.filter(c => c.trim());
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

function wrapChunk(bodyChunk, head, bodyAttrs = '', sparse = false) {
  const extraHead = sparse ? SPARSE_STYLE : '';
  const inner     = sparse ? `<pre>${bodyChunk}</pre>` : bodyChunk;
  return `<!DOCTYPE html><html><head>${head}${extraHead}</head><body${bodyAttrs}>${inner}</body></html>`;
}

// ── Temp file helpers ──────────────────────────────────────────────────────────
function writeChunkFiles(bodyChunks, head, bodyAttrs = '', sparse = false) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
  const paths = bodyChunks.map((chunk, i) => {
    const p = path.join(tmpDir, `chunk-${String(i).padStart(5, '0')}.html`);
    fs.writeFileSync(p, wrapChunk(chunk, head, bodyAttrs, sparse), 'utf8');
    return p;
  });
  return { tmpDir, paths };
}

function cleanupTmpDir(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Rendering — shared context from global browser pool ───────────────────────
// One context is created per job and shared across all chunks sequentially.
// Pages are opened and closed per chunk — avoids context overhead per chunk.
async function renderFile(tmpPath, options, context) {
  const {
    format = 'A4',
    margin = { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    printBackground = true,
    displayHeaderFooter = false,
  } = options;

  const page = await context.newPage();
  await page.setDefaultTimeout(120000);
  await blockResources(page);

  try {
    await page.goto(`file://${tmpPath}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(200); // shorter wait — CSS loads synchronously from file://
    return await page.pdf({ format, margin, printBackground, displayHeaderFooter });
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

async function renderWithFallback(tmpPath, options, context, depth = 0) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await renderFile(tmpPath, options, context);
    } catch (err) {
      const isPrintFail = /printToPDF|Printing failed/i.test(err.message);
      const isCrash     = /closed|crashed|disconnected|Target page/i.test(err.message);

      if (isCrash || attempt === MAX_RETRIES) throw err;

      if (isPrintFail && depth < 3) {
        // Split chunk in half and render each half separately
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

        let bufA, bufB;
        try {
          bufA = await renderWithFallback(pathA, options, context, depth + 1);
          bufB = await renderWithFallback(pathB, options, context, depth + 1);
          const merged = await PDFDocument.create();
          for (const buf of [bufA, bufB]) {
            const doc   = await PDFDocument.load(buf);
            const pages = await merged.copyPages(doc, doc.getPageIndices());
            pages.forEach(p => merged.addPage(p));
          }
          return Buffer.from(await merged.save());
        } finally {
          try { fs.unlinkSync(pathA); } catch (_) {}
          try { fs.unlinkSync(pathB); } catch (_) {}
          bufA = null; bufB = null;
        }
      }

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
  // Note: don't call doc.context.enumeratedIndirectObjects.clear() —
  // that's a private pdf-lib API that may be undefined on some PDF types
}

// ── Main entry ─────────────────────────────────────────────────────────────────
async function generatePdf(htmlContent, options = {}, progress = null) {
  const sparse = isSparseHtml(htmlContent);
  const estimatedPages = Math.ceil(htmlContent.length / 3000);

  if (estimatedPages < CHUNK_PAGE_THRESHOLD) {
    if (sparse) {
      if (progress) progress.log('Sparse HTML detected — wrapping in <pre> (single render)');
      htmlContent = normalizeSparseHtml(htmlContent);
    } else {
      if (progress) progress.log('Single render (small document)');
    }
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
    const tmpPath = path.join(tmpDir, 'doc.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');

    htmlContent = null;

    // Acquire warm browser from global pool — no cold start
    const browser = await browserPool.acquire();
    const context = await browser.newContext({
      bypassCSP: false, ignoreHTTPSErrors: false,
      javaScriptEnabled: true, permissions: [],
      viewport: { width: 1200, height: 800 },
    });
    try {
      const buffer = await renderWithFallback(tmpPath, options, context);
      const pages  = await countPdfPages(buffer);
      return { buffer, pages, chunks: 1 };
    } finally {
      try { await context.close(); } catch (_) {}
      browserPool.release(browser);
      cleanupTmpDir(tmpDir);
    }
  }

  // ── Large document path ─────────────────────────────────────────────────────
  const head = extractHead(htmlContent);
  const { attrs: bodyAttrs, content: rawBody } = extractBody(htmlContent);
  htmlContent = null;

  let bodyChunks;
  if (sparse) {
    if (progress) progress.log('Sparse HTML detected — wrapping each chunk in <pre>');
    bodyChunks = splitTextChunks(escapeSparse(rawBody), CHUNK_CHARS);
  } else {
    bodyChunks = splitBodySafe(rawBody, CHUNK_CHARS);
  }

  if (progress) {
    progress.total = bodyChunks.length;
    progress.log(`${bodyChunks.length} chunks  concurrency=${CONCURRENCY}  writing temp files...`);
  }

  const { tmpDir, paths } = writeChunkFiles(bodyChunks, head, bodyAttrs, sparse);
  bodyChunks.length = 0; // release chunk strings

  if (progress) progress.log('Rendering chunks...');

  const mergedDoc = await PDFDocument.create();
  const pdfParts  = new Array(paths.length);
  let nextMerge   = 0;
  let renderIdx   = 0;
  const lock      = { merging: false };

  async function flushMerge() {
    if (lock.merging) return;
    lock.merging = true;
    try {
      while (nextMerge < pdfParts.length && pdfParts[nextMerge] !== undefined) {
        await streamMerge(mergedDoc, pdfParts[nextMerge]);
        pdfParts[nextMerge] = null;
        nextMerge++;
      }
    } catch (err) {
      if (progress) progress.log(`  merge error at chunk ${nextMerge}: ${err.message.slice(0, 80)}`);
      nextMerge++;
    } finally {
      lock.merging = false;
    }
  }

  // Each worker acquires ONE browser from the pool and ONE context.
  // All chunks for that worker render sequentially inside the same context.
  async function worker(workerId) {
    const browser = await browserPool.acquire();
    const context = await browser.newContext({
      bypassCSP: false, ignoreHTTPSErrors: false,
      javaScriptEnabled: true, permissions: [],
      viewport: { width: 1200, height: 800 },
    });
    try {
      while (true) {
        const i = renderIdx++;
        if (i >= paths.length) break;

        try {
          pdfParts[i] = await renderWithFallback(paths[i], options, context);
        } catch (err) {
          if (progress) progress.log(`  chunk ${i} failed permanently: ${err.message.slice(0, 80)}`);
          const blank = await PDFDocument.create();
          blank.addPage();
          pdfParts[i] = Buffer.from(await blank.save());
        }

        if (progress) progress.tick();
        await flushMerge();
      }
    } finally {
      try { await context.close(); } catch (_) {}
      browserPool.release(browser);
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => worker(id)));
    await flushMerge();
  } finally {
    cleanupTmpDir(tmpDir);
  }

  const buffer = Buffer.from(await mergedDoc.save());
  const pages  = await countPdfPages(buffer);
  return { buffer, pages, chunks: paths.length };
}

module.exports = { generatePdf };
