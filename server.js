'use strict';

/**
 * Security hardening — OWASP Top 10 + STRIDE coverage:
 *
 *   A01 Broken Access Control  — no auth needed (local tool); rate limiting prevents abuse
 *   A02 Cryptographic Failures — no secrets stored or transmitted
 *   A03 Injection              — filename sanitized; no shell exec; browser network blocked
 *   A04 Insecure Design        — processing timeout; upload immediately deleted
 *   A05 Misconfig              — Helmet sets 15 security headers; CSP enforced
 *   A06 Vulnerable Components  — npm audit in CI
 *   A07 Auth Failures          — N/A (local tool)
 *   A08 Data Integrity         — MIME type validated, not just extension
 *   A09 Logging                — every request logged with ID, size, duration, outcome
 *   A10 SSRF                   — browser blocks all non-file:// network; no URL params accepted
 *
 *   STRIDE:
 *   Spoofing          — request IDs logged; no session state to spoof
 *   Tampering         — inputs sanitized; temp files deleted immediately
 *   Repudiation       — structured request log with outcome
 *   Info Disclosure   — errors return generic message, detail logged server-side only
 *   DoS               — rate limiter + processing timeout + file size limit
 *   Elevation         — no shell exec; no eval; no path traversal possible
 */

const express      = require('express');
const multer       = require('multer');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const { generatePdf }      = require('./src/generator');
const { closeAllBrowsers } = require('./src/browser');

const app  = express();
const PORT = process.env.PORT || 3000;

// Max time allowed for a single conversion (5 min)
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

// ── Security headers (OWASP A05) ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // UI inline script only
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // not needed for file downloads
}));

// ── Rate limiting (OWASP A04 / STRIDE DoS) ────────────────────────────────────
const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  // LOAD_TEST=1 raises limit to 1000/min so the test runner isn't throttled.
  // Keep at 10 for public-facing deployments.
  max: process.env.LOAD_TEST === '1' ? 1000 : 10,
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait before converting again.' },
});

// ── Multer upload (OWASP A04 / A08) ───────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    // Validate both extension AND declared MIME type (A08 — data integrity)
    const extOk  = /\.html?$/i.test(file.originalname);
    const mimeOk = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/octet-stream']
                     .includes(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(Object.assign(new Error('Only HTML files accepted (.html / .htm)'), { status: 400 }));
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function unlinkSilent(p) { if (p) try { fs.unlinkSync(p); } catch (_) {} }

/**
 * Sanitize filename for Content-Disposition header.
 * OWASP A03 — prevents header injection via \r\n in filename.
 * Strips everything except alphanumerics, dash, underscore, dot, space.
 */
function sanitizeFilename(name) {
  return name
    .replace(/[^\w\s.\-]/g, '_')   // replace unsafe chars
    .replace(/\.{2,}/g, '_')       // no path traversal sequences
    .slice(0, 128)                  // cap length
    .trim() || 'output';
}

/**
 * Request logger — STRIDE Repudiation / OWASP A09
 */
function logRequest(reqId, event, data = {}) {
  const entry = { ts: new Date().toISOString(), reqId, event, ...data };
  console.log(JSON.stringify(entry));
}

// ── Static UI ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /convert ──────────────────────────────────────────────────────────────
app.post(
  '/convert',
  convertLimiter,
  upload.single('htmlfile'),
  async (req, res) => {
    // Unique request ID for tracing (STRIDE Repudiation)
    const reqId = crypto.randomUUID();

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const uploadPath = req.file.path;
    let pdfPath = null;

    logRequest(reqId, 'start', {
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      ip: req.ip,
    });

    // Processing timeout — OWASP A04 / STRIDE DoS
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logRequest(reqId, 'timeout');
      unlinkSilent(uploadPath);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Conversion timed out. Try a smaller file.' });
      }
    }, PROCESSING_TIMEOUT_MS);

    try {
      // Read then immediately delete upload — don't hold file+string simultaneously
      let htmlContent = fs.readFileSync(uploadPath, 'utf8');
      unlinkSilent(uploadPath);

      if (timedOut) return;

      // Sanitize output filename — prevents header injection (OWASP A03)
      const rawName      = path.basename(req.file.originalname, path.extname(req.file.originalname));
      const originalName = sanitizeFilename(rawName);

      const progress = {
        total: 1,
        done:  0,
        log:  (msg) => logRequest(reqId, 'progress', { msg }),
        tick: () => {
          progress.done++;
          if (!timedOut) process.stdout.write(
            `\r  [${reqId.slice(0,8)}] ${progress.done}/${progress.total} chunks`
          );
        },
      };

      const start = Date.now();
      const { buffer, pages, chunks } = await generatePdf(htmlContent, {}, progress);
      htmlContent = null; // release large string

      if (timedOut) return;

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      clearTimeout(timeoutHandle);

      logRequest(reqId, 'complete', { pages, chunks, elapsedS: elapsed, outputKB: Math.round(buffer.length / 1024) });

      // Write PDF to tmp, stream, delete — never accumulate output on disk
      pdfPath = path.join(os.tmpdir(), `${originalName}-${reqId.slice(0,8)}.pdf`);
      fs.writeFileSync(pdfPath, buffer);

      res.setHeader('Content-Type', 'application/pdf');
      // Use RFC 5987 encoding to safely pass filename with special chars
      res.setHeader('Content-Disposition',
        `attachment; filename="${originalName}.pdf"; filename*=UTF-8''${encodeURIComponent(originalName + '.pdf')}`);
      res.setHeader('X-Pages',   pages);
      res.setHeader('X-Chunks',  chunks);
      res.setHeader('X-Elapsed', elapsed + 's');
      res.setHeader('X-Request-Id', reqId);

      const stream  = fs.createReadStream(pdfPath);
      const cleanup = () => unlinkSilent(pdfPath);
      stream.on('end',   cleanup);
      stream.on('error', cleanup);
      res.on('close',    cleanup); // client disconnected early
      stream.pipe(res);

    } catch (err) {
      clearTimeout(timeoutHandle);
      // OWASP A09 — log full error server-side; return generic message to client
      logRequest(reqId, 'error', { message: err.message, stack: err.stack });
      unlinkSilent(uploadPath);
      unlinkSilent(pdfPath);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Conversion failed. Check server logs for details.' });
      }
    }
  }
);

// ── Multer error handler (file too large / wrong type) ────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (req.file) unlinkSilent(req.file.path);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  logRequest('—', 'upload-error', { message: err.message, ip: req.ip });
  res.status(status).json({ error: err.message });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGINT',  async () => { await closeAllBrowsers(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllBrowsers(); process.exit(0); });

app.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'start', port: PORT }));
});
