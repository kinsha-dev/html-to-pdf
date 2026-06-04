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

// Multer: store uploads in /tmp, accept only .html / .htm
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter(req, file, cb) {
    if (/\.html?$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .html / .htm files are accepted'));
  },
});

// Serve the upload UI
app.use(express.static(path.join(__dirname, 'public')));

// POST /convert — upload HTML, get PDF back as a download
app.post('/convert', upload.single('htmlfile'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const uploadPath = req.file.path;
  let pdfPath = null;

  try {
    const htmlContent = fs.readFileSync(uploadPath, 'utf8');
    const originalName = path.basename(req.file.originalname, path.extname(req.file.originalname));

    // Progress logger for server console
    const progress = {
      total: 1,
      done: 0,
      log: (msg) => console.log(`  [${req.file.originalname}] ${msg}`),
      tick: () => {
        progress.done++;
        const pct = Math.round((progress.done / progress.total) * 100);
        process.stdout.write(`\r  [${req.file.originalname}] ${progress.done}/${progress.total} chunks (${pct}%)`);
        if (progress.done === progress.total) process.stdout.write('\n');
      },
    };

    console.log(`\n→ Converting: ${req.file.originalname} (${(htmlContent.length / 1024 / 1024).toFixed(2)} MB)`);
    const start = Date.now();

    const { buffer, pages, chunks } = await generatePdf(htmlContent, {}, progress);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✓ Done: ${pages} pages, ${chunks} chunks, ${elapsed}s, ${(buffer.length / 1024).toFixed(0)} KB`);

    // Write PDF to a temp file so we can stream it
    pdfPath = path.join(os.tmpdir(), `${originalName}-${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, buffer);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${originalName}.pdf"`);
    res.setHeader('X-Pages', pages);
    res.setHeader('X-Chunks', chunks);
    res.setHeader('X-Elapsed', elapsed + 's');

    const stream = fs.createReadStream(pdfPath);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(pdfPath); } catch (_) {} });
    stream.on('error', () => res.status(500).end());

  } catch (err) {
    console.error('Convert error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(uploadPath); } catch (_) {}
  }
});

// Graceful shutdown
process.on('SIGINT',  async () => { await closeAllBrowsers(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllBrowsers(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`\nhtml-to-pdf server running at http://localhost:${PORT}\n`);
});
