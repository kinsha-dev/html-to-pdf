'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const pLimit = require('p-limit');
const { getBrowser, createContext, blockResources } = require('./browser');

const CHUNK_PAGE_THRESHOLD = 1000;
const CHUNK_SIZE = 400; // estimated pages per chunk

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
  // Split on top-level section/h1 boundaries
  const sectionRegex = /(?=<(?:h1|section|article)[^>]*>)/gi;
  const parts = htmlContent.split(sectionRegex).filter(Boolean);

  if (parts.length <= 1) {
    // Fallback: split by estimated character count (~3000 chars per page)
    const charsPerPage = 3000;
    const charsPerChunk = charsPerPage * chunkSize;
    const chunks = [];
    for (let i = 0; i < htmlContent.length; i += charsPerChunk) {
      chunks.push(htmlContent.slice(i, i + charsPerChunk));
    }
    return chunks;
  }

  // Group parts into chunks
  const chunks = [];
  for (let i = 0; i < parts.length; i += chunkSize) {
    chunks.push(parts.slice(i, i + chunkSize).join(''));
  }
  return chunks;
}

function wrapChunk(chunk, baseHtml) {
  // Preserve <head> styles from original document for each chunk
  const headMatch = baseHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : '';
  return `<!DOCTYPE html><html><head>${head}</head><body>${chunk}</body></html>`;
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

async function estimatePageCount(htmlContent) {
  // Rough heuristic: 3000 chars ~ 1 page
  return Math.ceil(htmlContent.length / 3000);
}

async function generatePdf(htmlContent, options = {}) {
  const estimated = await estimatePageCount(htmlContent);

  if (estimated < CHUNK_PAGE_THRESHOLD) {
    return renderHtmlToPdf(htmlContent, options);
  }

  // Large document: chunk + parallel render + merge
  const chunks = splitHtmlIntoChunks(htmlContent, CHUNK_SIZE);
  const wrappedChunks = chunks.map(c => wrapChunk(c, htmlContent));

  const concurrency = Math.max(2, Math.floor(require('os').cpus().length * 1.5));
  const limit = pLimit(concurrency);

  const pdfParts = await Promise.all(
    wrappedChunks.map((chunk, i) =>
      limit(() => {
        process.stderr.write(`  Rendering chunk ${i + 1}/${wrappedChunks.length}...\n`);
        return renderHtmlToPdf(chunk, options);
      })
    )
  );

  return mergePdfs(pdfParts);
}

module.exports = { generatePdf };
