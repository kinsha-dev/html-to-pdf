'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { generatePdf } = require('./src/generator');
const { closeAllBrowsers } = require('./src/browser');

const app  = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/\.html?$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .html / .htm files are accepted'));
  },
});

app.use(express.static(path.join(__dirname, 'public')));

function unlinkSilent(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

app.post('/convert', upload.single('htmlfile'), async (req, res) => {
  // FIX: multer errors (wrong file type, too large) leave no req.file — clean up
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const uploadPath = req.file.path;
  let pdfPath = null;

  try {
    // FIX: read into string then immediately unlink the upload — no need to hold
    // both the file on disk AND the string in memory simultaneously
    let htmlContent = fs.readFileSync(uploadPath, 'utf8');
    unlinkSilent(uploadPath); // delete upload right after read

    const originalName = path.basename(req.file.originalname, path.extname(req.file.originalname));

    const progress = {
      total: 1,
      done:  0,
      log:  (msg) => console.log(`  [${req.file.originalname}] ${msg}`),
      tick: () => {
        progress.done++;
        const pct = Math.round((progress.done / progress.total) * 100);
        process.stdout.write(`\r  [${req.file.originalname}] ${progress.done}/${progress.total} chunks (${pct}%)`);
        if (progress.done === progress.total) process.stdout.write('\n');
      },
    };

    console.log(`\n→ Converting: ${req.file.originalname} (${(Buffer.byteLength(htmlContent) / 1024 / 1024).toFixed(2)} MB)`);
    const start = Date.now();

    const { buffer, pages, chunks } = await generatePdf(htmlContent, {}, progress);

    // FIX: release htmlContent string — generatePdf already nulls it internally
    // but the local reference here keeps it alive; null it explicitly
    htmlContent = null;

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✓ Done: ${pages} pages, ${chunks} chunks, ${elapsed}s, ${(buffer.length / 1024).toFixed(0)} KB`);

    // Write PDF to temp, stream to client, then delete — never accumulate PDFs on disk
    pdfPath = path.join(os.tmpdir(), `${originalName}-${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, buffer);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}.pdf"`);
    res.setHeader('X-Pages', pages);
    res.setHeader('X-Chunks', chunks);
    res.setHeader('X-Elapsed', elapsed + 's');

    const stream = fs.createReadStream(pdfPath);
    stream.pipe(res);

    // FIX: delete PDF temp file on both finish and error (client disconnect etc.)
    const cleanup = () => unlinkSilent(pdfPath);
    stream.on('end',   cleanup);
    stream.on('error', cleanup);
    res.on('close',    cleanup); // client disconnected early

  } catch (err) {
    console.error('Convert error:', err.message);
    // FIX: clean up upload in case early unlink didn't happen (e.g. readFileSync threw)
    unlinkSilent(uploadPath);
    unlinkSilent(pdfPath);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// FIX: handle multer errors (file too large, wrong type) — without this,
// the uploaded temp file is left on disk
app.use((err, req, res, next) => {
  if (req.file) unlinkSilent(req.file.path);
  res.status(400).json({ error: err.message });
});

process.on('SIGINT',  async () => { await closeAllBrowsers(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllBrowsers(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`\nhtml-to-pdf server running at http://localhost:${PORT}\n`);
});
