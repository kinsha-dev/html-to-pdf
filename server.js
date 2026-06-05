'use strict';

const express      = require('express');
const multer       = require('multer');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const { Readable } = require('stream');

const { generatePdf }      = require('./src/generator');
const { pool: browserPool } = require('./src/browser-pool');
const { queue }            = require('./src/job-queue');
const { getRedisClient }   = require('./src/redis-client');

const app  = express();
const PORT = process.env.PORT || 3000;
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

// ── Security headers ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── Rate limiting ──────────────────────────────────────────────────────────────
const convertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.LOAD_TEST === '1' ? 1000 : 10,
  skip: req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests — please wait.' },
});

// ── Multer ─────────────────────────────────────────────────────────────────────
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const extOk  = /\.html?$/i.test(file.originalname);
    const mimeOk = ['text/html','application/xhtml+xml','text/plain','application/octet-stream']
                     .includes(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(Object.assign(new Error('Only HTML files accepted'), { status: 400 }));
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────────
const unlinkSilent = p => { if (p) try { fs.unlinkSync(p); } catch (_) {} };

function sanitizeFilename(name) {
  return name.replace(/[^\w\s.\-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 128).trim() || 'output';
}

function log(reqId, event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), reqId, event, ...data }));
}

// ── Static UI ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /status/:jobId — check Redis job status ────────────────────────────────
app.get('/status/:jobId', async (req, res) => {
  const job = await queue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── GET /pool — browser pool stats ────────────────────────────────────────────
app.get('/pool', (req, res) => {
  res.json({
    pool:  browserPool.stats(),
    queue: { active: queue.activeCount(), pending: queue.pendingCount() },
  });
});

// ── POST /convert ──────────────────────────────────────────────────────────────
app.post('/convert', convertLimiter, upload.single('htmlfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const uploadPath   = req.file.path;
  const reqId        = crypto.randomUUID();
  const originalName = sanitizeFilename(
    path.basename(req.file.originalname, path.extname(req.file.originalname))
  );

  log(reqId, 'start', { filename: req.file.originalname, sizeBytes: req.file.size, ip: req.ip,
    queue: { active: queue.activeCount(), pending: queue.pendingCount() } });

  // Register job in Redis immediately
  const jobId = await queue.enqueue({ reqId, filename: req.file.originalname });

  let timedOut = false;
  const timeoutHandle = setTimeout(async () => {
    timedOut = true;
    log(reqId, 'timeout');
    await queue.setStatus(jobId, 'error', { error: 'timeout' });
    unlinkSilent(uploadPath);
    if (!res.headersSent) res.status(503).json({ error: 'Conversion timed out.' });
  }, PROCESSING_TIMEOUT_MS);

  try {
    // Read & delete upload immediately
    let htmlContent = fs.readFileSync(uploadPath, 'utf8');
    unlinkSilent(uploadPath);

    if (timedOut) return;

    await queue.setStatus(jobId, 'processing');

    const progress = {
      total: 1, done: 0,
      log:  msg => log(reqId, 'progress', { msg }),
      tick: () => {
        progress.done++;
        if (!timedOut) process.stdout.write(
          `\r  [${reqId.slice(0,8)}] ${progress.done}/${progress.total} chunks`
        );
      },
    };

    const start = Date.now();

    // Run through the concurrency gate — queues if MAX_CONCURRENT_JOBS reached
    const { buffer, pages, chunks } = await queue.run(() =>
      generatePdf(htmlContent, {}, progress)
    );

    htmlContent = null;

    if (timedOut) return;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    clearTimeout(timeoutHandle);

    // Store result metadata in Redis
    await queue.setStatus(jobId, 'done', {
      pages, chunks, elapsedS: elapsed,
      outputKB: Math.round(buffer.length / 1024),
    });

    log(reqId, 'complete', { pages, chunks, elapsedS: elapsed, outputKB: Math.round(buffer.length / 1024) });

    // Stream PDF directly from memory — no temp file needed
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${originalName}.pdf"; filename*=UTF-8''${encodeURIComponent(originalName + '.pdf')}`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Pages',      pages);
    res.setHeader('X-Chunks',     chunks);
    res.setHeader('X-Elapsed',    elapsed + 's');
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('X-Job-Id',     jobId);

    Readable.from(buffer).pipe(res);

  } catch (err) {
    clearTimeout(timeoutHandle);
    log(reqId, 'error', { message: err.message, stack: err.stack });
    await queue.setStatus(jobId, 'error', { error: err.message }).catch(() => {});
    unlinkSilent(uploadPath);
    if (!res.headersSent) res.status(500).json({ error: 'Conversion failed.' });
  }
});

// ── Multer error handler ───────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (req.file) unlinkSilent(req.file.path);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  log('—', 'upload-error', { message: err.message, ip: req.ip });
  res.status(status).json({ error: err.message });
});

// ── Startup ────────────────────────────────────────────────────────────────────
async function start() {
  // Warm browser pool before accepting traffic
  await browserPool.warm();

  // Log Redis mode
  getRedisClient(); // triggers init log

  app.listen(PORT, () => {
    log('server', 'start', { port: PORT,
      maxJobs: process.env.MAX_CONCURRENT_JOBS || 1,
      poolSize: process.env.BROWSER_POOL_SIZE || 2,
      chunkPages: process.env.CHUNK_PAGES || 200 });
  });
}

process.on('SIGINT',  async () => { await browserPool.closeAll(); process.exit(0); });
process.on('SIGTERM', async () => { await browserPool.closeAll(); process.exit(0); });

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
