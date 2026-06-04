'use strict';

const os = require('os');
const { PDFDocument } = require('pdf-lib');
const pLimit = require('p-limit');
const { getBrowser, createContext, blockResources } = require('./browser');

const CHUNK_PAGE_THRESHOLD = 1000;
const CHUNK_SIZE = 400;

async function renderHtmlToPdf(htmlContent, options = {}) {
  const {
    format = 'A4',
    margin = { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    printBackground = true,
    displayHeaderFooter = false,
  } = options;

  const browser = await getBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();
  await page.setDefaultNavigationTimeout(60000);
  await blockResources(page);

  try {
    await page.setContent(htmlContent, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format,
      margin,
      printBackground,
      displayHeaderFooter,
    });
    return pdfBuffer;
  } finally {
    await context.close();
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

function wrapChunk(chunk, baseHtml) {
  const headMatch = baseHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : '';
  return `<!DOCTYPE html><html><head>${head}</head><body>${chunk}</body></html>`;
}

async function countPdfPages(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

async function mergePdfs(pdfBuffers) {
  const merged = await PDFDocument.create();
  for (const buffer of pdfBuffers) {
    const doc = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}

async function generatePdf(htmlContent, options = {}, onProgress = null) {
  const estimatedPages = Math.ceil(htmlContent.length / 3000);

  if (estimatedPages < CHUNK_PAGE_THRESHOLD) {
    const buffer = await renderHtmlToPdf(htmlContent, options);
    const pages = await countPdfPages(buffer);
    return { buffer, pages, chunks: 1 };
  }

  const chunks = splitHtmlIntoChunks(htmlContent, CHUNK_SIZE);
  const wrappedChunks = chunks.map(c => wrapChunk(c, htmlContent));
  const concurrency = Math.max(2, Math.floor(os.cpus().length * 1.5));
  const limit = pLimit(concurrency);

  let done = 0;
  const pdfParts = await Promise.all(
    wrappedChunks.map((chunk, i) =>
      limit(async () => {
        const buf = await renderHtmlToPdf(chunk, options);
        done++;
        if (onProgress) onProgress(done, wrappedChunks.length);
        return buf;
      })
    )
  );

  const buffer = await mergePdfs(pdfParts);
  const pages = await countPdfPages(buffer);
  return { buffer, pages, chunks: wrappedChunks.length };
}

module.exports = { generatePdf };
