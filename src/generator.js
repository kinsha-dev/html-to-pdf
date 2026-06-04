'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { getBrowser, closeBrowser, createContext, blockResources } = require('./browser');

const CHUNK_SIZE = 50;             // ~50 pages per chunk — small DOM = fast layout
const MAX_RETRIES = 3;
const CONCURRENCY = Math.min(4, Math.max(2, Math.floor(os.cpus().length * 1.5)));
const RESTART_EVERY = 20;          // restart browser every N chunks to reclaim memory
const CHUNK_PAGE_THRESHOLD = 1000; // estimated pages before chunking kicks in

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Write chunk HTML to a temp file and render via file:// — avoids CDP transfer overhead
async function renderChunkFile(tmpPath, options = {}) {
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
    await page.waitForTimeout(150); // let CSS finish applying
    return await page.pdf({ format, margin, printBackground, displayHeaderFooter });
  } finally {
    await page.close();
    await context.close();
  }
}

async function renderWithRetry(tmpPath, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await renderChunkFile(tmpPath, options);
    } catch (err) {
      const isCrash = /closed|crashed|disconnected|Target page/i.test(err.message);
      if (attempt === retries) throw err;
      if (isCrash) await closeBrowser();
      await sleep(1000 * attempt);
    }
  }
}

function splitHtmlIntoChunks(htmlContent, chunkSize) {
  const sectionRegex = /(?=<(?:h1|section|article)[^>]*>)/gi;
  const parts = htmlContent.split(sectionRegex).filter(Boolean);

  if (parts.length <= 1) {
    const charsPerChunk = 3000 * chunkSize;
    const chunks = [];
    for (let i = 0; i < htmlContent.length; i += charsPerChunk) {
      chunks.push(htmlContent.slice(i, i + charsPerChunk));
    }
    return chunks;
  }

  const chunks = [];
  for (let i = 0; i < parts.length; i += chunkSize) {
    chunks.push(parts.slice(i, i + chunkSize).join(''));
  }
  return chunks;
}

function wrapChunk(chunk, head) {
  return `<!DOCTYPE html><html><head>${head}</head><body>${chunk}</body></html>`;
}

// Write all chunks to /tmp in parallel — fast local I/O, no CDP cost
function writeChunkFiles(chunks, head) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
  const paths = chunks.map((chunk, i) => {
    const p = path.join(tmpDir, `chunk-${String(i).padStart(4, '0')}.html`);
    fs.writeFileSync(p, wrapChunk(chunk, head), 'utf8');
    return p;
  });
  return { tmpDir, paths };
}

function cleanupTmpDir(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

// Stream merge: add pages to merged doc as each part arrives (no batch wait)
async function streamMerge(mergedDoc, pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer);
  const pages = await mergedDoc.copyPages(doc, doc.getPageIndices());
  pages.forEach(p => mergedDoc.addPage(p));
}

async function generatePdf(htmlContent, options = {}, progress = null) {
  const estimatedPages = Math.ceil(htmlContent.length / 3000);

  if (estimatedPages < CHUNK_PAGE_THRESHOLD) {
    if (progress) progress.log('Single render (small document)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-pdf-'));
    const tmpPath = path.join(tmpDir, 'doc.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');
    try {
      const buffer = await renderWithRetry(tmpPath, options);
      const pages = await countPdfPages(buffer);
      return { buffer, pages, chunks: 1 };
    } finally {
      cleanupTmpDir(tmpDir);
    }
  }

  // --- Large document path ---
  const chunks = splitHtmlIntoChunks(htmlContent, CHUNK_SIZE);
  const headMatch = htmlContent.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : '';

  if (progress) {
    progress.total = chunks.length;
    progress.log(`${chunks.length} chunks  concurrency=${CONCURRENCY}  writing temp files...`);
  }

  const { tmpDir, paths } = writeChunkFiles(chunks, head);

  if (progress) progress.log('Rendering chunks...');

  // Results array preserves order; merge doc built as chunks complete
  const mergedDoc = await PDFDocument.create();
  const pdfParts = new Array(chunks.length);
  let nextMerge = 0;
  let renderIdx = 0;
  const lock = { merging: false };

  // Flush completed sequential parts into mergedDoc
  async function flushMerge() {
    if (lock.merging) return;
    lock.merging = true;
    while (nextMerge < pdfParts.length && pdfParts[nextMerge] !== undefined) {
      await streamMerge(mergedDoc, pdfParts[nextMerge]);
      pdfParts[nextMerge] = null; // free memory immediately
      nextMerge++;
    }
    lock.merging = false;
  }

  async function worker(workerId) {
    let localCount = 0;
    while (true) {
      const i = renderIdx++;
      if (i >= paths.length) break;

      // Per-worker browser restart every RESTART_EVERY chunks
      if (localCount > 0 && localCount % RESTART_EVERY === 0) {
        await closeBrowser();
        await sleep(300);
      }

      pdfParts[i] = await renderWithRetry(paths[i], options);
      localCount++;

      if (progress) progress.tick();
      await flushMerge();
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => worker(id)));
    // Final flush for any remaining parts
    await flushMerge();
  } finally {
    cleanupTmpDir(tmpDir);
    await closeBrowser();
  }

  const buffer = Buffer.from(await mergedDoc.save());
  const pages = await countPdfPages(buffer);
  return { buffer, pages, chunks: chunks.length };
}

module.exports = { generatePdf };
