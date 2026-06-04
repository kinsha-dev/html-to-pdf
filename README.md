# html-to-pdf

Convert HTML files to PDF using Playwright + Chromium headless rendering. Supports a CLI for local use and an Express web server with a drag-and-drop upload UI.

---

## Features

- Accurate CSS rendering via Playwright + Chromium (latest)
- Auto-chunking for large documents (1000+ pages) with parallel rendering
- HTML-safe tag-boundary splitting — never cuts inside an element
- Recursive chunk halving fallback when `printToPDF` fails
- Per-worker isolated Chromium instances — one crash doesn't kill all workers
- Stream merge with `pdf-lib` — memory freed as each chunk completes
- Web UI with drag-and-drop upload, live progress bar, and instant PDF download
- Generation stats: time, pages, peak memory, CPU, file sizes

---

## Requirements

| Dependency | Version |
|---|---|
| Node.js | ≥ 18 |
| npm | ≥ 9 |

All other dependencies (including Chromium) are installed automatically.

---

## Installation

```bash
git clone https://github.com/kinsha-dev/html-to-pdf.git
cd html-to-pdf
npm install
npx playwright install chromium
```

---

## CLI Usage

### Basic

```bash
node cli.js input.html
# Output: input.pdf (same directory as input)
```

### Specify output path

```bash
node cli.js input.html -o /path/to/output.pdf
```

### All options

```bash
node cli.js <input> [options]
```

| Flag | Default | Description |
|---|---|---|
| `-o, --output <path>` | `<input>.pdf` | Output PDF file path |
| `-f, --format <format>` | `A4` | Page format: `A4`, `A3`, `Letter`, `Legal` |
| `--margin-top <size>` | `20mm` | Top margin (any CSS unit: `mm`, `px`, `cm`) |
| `--margin-bottom <size>` | `20mm` | Bottom margin |
| `--margin-left <size>` | `15mm` | Left margin |
| `--margin-right <size>` | `15mm` | Right margin |
| `--no-background` | — | Skip background colors and images |
| `--header-footer` | — | Enable Chromium's default header/footer |
| `-V, --version` | — | Print version |
| `-h, --help` | — | Show help |

### Examples

```bash
# A3 landscape-style wide layout
node cli.js report.html -o report.pdf --format A3

# US Letter with larger margins
node cli.js doc.html --format Letter --margin-top 30mm --margin-bottom 30mm

# Skip backgrounds (faster, smaller PDF)
node cli.js styled.html --no-background

# Add page numbers via Chromium header/footer
node cli.js doc.html --header-footer
```

### Sample output

```
Input:  /path/to/document.html
Output: /path/to/document.pdf
Format: A4
Generating PDF...

  665 chunks  concurrency=3  writing temp files...
  Rendering chunks...
  [████████████████████████████░░]  620/665  93%  elapsed 4m12s  ETA 18s  mem 312MB  chunk 0.8s

PDF written → /path/to/document.pdf

────────────────────────────────────────────
  Generation Stats
────────────────────────────────────────────
  Time               4m38s
  Pages              8240
  Chunks             665
  Peak Memory        418 MB
  End Memory (RSS)   91 MB
  CPU (end)          22%
  Input size         100.00 MB
  Output size        24.3 MB
────────────────────────────────────────────
```

---

## Web Server

### Start

```bash
node server.js
# → http://localhost:3000
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on |

```bash
PORT=8080 node server.js
```

### Upload UI

Open `http://localhost:3000` in a browser. Drag and drop or click to select an `.html` / `.htm` file (up to 200 MB). The server converts it and returns a direct PDF download link. The stats panel shows pages, output size, and conversion time.

### REST API

```
POST /convert
Content-Type: multipart/form-data
Field: htmlfile  (the HTML file)
```

**Response:** Binary PDF stream with headers:

| Header | Description |
|---|---|
| `Content-Type` | `application/pdf` |
| `Content-Disposition` | `attachment; filename="<original-name>.pdf"` |
| `X-Pages` | Total pages in generated PDF |
| `X-Chunks` | Number of rendering chunks used |
| `X-Elapsed` | Wall-clock conversion time (e.g. `4.3s`) |

**curl example:**

```bash
curl -X POST http://localhost:3000/convert \
  -F "htmlfile=@document.html" \
  -o document.pdf \
  -D -
```

**Error response (JSON):**

```json
{ "error": "Only .html / .htm files are accepted" }
```

---

## Configuration Reference

### Chunking (`src/generator.js`)

| Constant | Default | Description |
|---|---|---|
| `CHUNK_CHARS` | `150000` | Characters per chunk (~50 pages at 3000 chars/page). Lower = faster per-chunk render, more chunks total. |
| `CHUNK_PAGE_THRESHOLD` | `1000` | Estimated page count above which chunking activates. |
| `CONCURRENCY` | `min(3, cpus/2)` | Parallel Chromium workers. Increase for more cores, decrease if hitting OOM. |
| `RESTART_EVERY` | `15` | Restart each worker's browser every N chunks to reclaim leaked Chromium memory. |
| `MAX_RETRIES` | `2` | Retries per chunk before falling back to recursive halving. |

**Tuning for large documents:**

```
Small machine (4 cores, 8 GB RAM)  → CONCURRENCY=1, CHUNK_CHARS=100000
Standard (8 cores, 16 GB RAM)      → CONCURRENCY=3, CHUNK_CHARS=150000 (default)
Large (16+ cores, 32 GB RAM)       → CONCURRENCY=6, CHUNK_CHARS=200000
```

### Browser (`src/browser.js`)

| Flag | Purpose |
|---|---|
| `--js-flags=--max-old-space-size=384` | Cap V8 heap per renderer at 384 MB. Raise if renders fail on complex pages. |
| `--disable-gpu` | Required for headless on most servers. |
| `--no-sandbox` | Required in Docker / CI environments. |
| `--disable-cache` | Prevents cross-chunk cache accumulation. |

**Resource blocking** — the following are blocked per page to speed up rendering:

- Resource types: all except `document` and `stylesheet`
- URL patterns: `analytics`, `tracking`, `google-analytics`, `facebook`, `hotjar`, `segment`, `gtm`

To allow additional resource types (e.g. images for branded PDFs), edit `blockResources()` in `src/browser.js`:

```js
if (!['document', 'stylesheet', 'image'].includes(type)) return route.abort();
```

### Server (`server.js`)

| Setting | Default | How to change |
|---|---|---|
| Max upload size | `200 MB` | `limits: { fileSize: 200 * 1024 * 1024 }` in multer config |
| Accepted file types | `.html`, `.htm` | `fileFilter` regex in multer config |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  CLI (cli.js)          Web UI (public/index.html)   │
│       │                        │                    │
│       └──────────┬─────────────┘                    │
│                  ▼                                   │
│           server.js / generatePdf()                 │
│                  │                                   │
│         src/generator.js                            │
│                  │                                   │
│    ┌─────────────▼──────────────┐                   │
│    │  splitBodySafe()           │                   │
│    │  Write N chunks to /tmp    │                   │
│    └─────────────┬──────────────┘                   │
│                  │                                   │
│     ┌────────────┼────────────┐                     │
│     ▼            ▼            ▼                     │
│  Worker-0     Worker-1    Worker-2                  │
│  browser-0    browser-1   browser-2                 │
│  (isolated)   (isolated)  (isolated)                │
│     │            │            │                     │
│     └────────────┼────────────┘                     │
│                  ▼                                   │
│         streamMerge() → pdf-lib                     │
│                  │                                   │
│           output.pdf                                │
└─────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **Per-worker browsers** — each worker owns its own Chromium process. A crash in one worker restarts only that worker; others continue unaffected.
- **`page.goto(file://)`** instead of `page.setContent()` — chunks are written to `/tmp` and loaded from disk, avoiding the CDP socket transfer overhead for large HTML.
- **Tag-boundary splitting** — `splitBodySafe()` walks back to the last `>` before each cut point, guaranteeing valid HTML in every chunk.
- **Recursive halving fallback** — if `printToPDF` fails (malformed content, oversized chunk), `renderWithFallback()` splits the chunk in half and merges the two resulting PDFs, up to 3 levels deep (1/8th original size).

---

## Project Structure

```
html-to-pdf/
├── cli.js              # CLI entry point (Commander)
├── server.js           # Express web server + /convert endpoint
├── src/
│   ├── generator.js    # Core: chunking, rendering, merging
│   ├── browser.js      # Playwright browser pool (per-worker)
│   ├── stats.js        # CPU/memory tracker for CLI stats panel
│   └── progress.js     # Live progress bar renderer
├── public/
│   └── index.html      # Web upload UI
├── sample.html         # Test document
└── package.json
```

---

## Docker

```dockerfile
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t html-to-pdf .
docker run -p 3000:3000 html-to-pdf
```

> **Note:** The `--no-sandbox` flag in `browser.js` is required inside Docker. It is already set by default.

---

## License

ISC
