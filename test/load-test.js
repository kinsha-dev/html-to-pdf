#!/usr/bin/env node
'use strict';

/**
 * Load test — max TPS with 10MB.html
 *
 * Rules:
 *   - Response time must stay < 15s
 *   - System CPU and memory must stay < 50%
 *   - Calibrate concurrency up/down every CALIBRATE_INTERVAL_MS
 *   - Run for DURATION_MS (default 1 hour)
 *   - Save full report to test/results-<timestamp>.json
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ─────────────────────────────────────────────────────────────────────
const SERVER_URL          = process.env.SERVER_URL || 'http://localhost:3000';
const HTML_FILE           = path.resolve(__dirname, '..', '10MB.html');
const DURATION_MS         = 60 * 60 * 1000;   // 1 hour
const CALIBRATE_EVERY_MS  = 30_000;            // recalibrate every 30s
const SAMPLE_WINDOW       = 10;                // requests in rolling window for avg RT
const MAX_RESPONSE_MS     = 15_000;            // 15s ceiling
const MAX_CPU_PCT         = 50;
const MAX_MEM_PCT         = 50;
const RT_SCALE_DOWN_MS    = 13_000;            // start backing off at 13s
const RT_SCALE_UP_MS      = 8_000;             // scale up if avg RT < 8s
const CONCURRENCY_MIN     = 1;
const CONCURRENCY_MAX     = 16;
const CONCURRENCY_INIT    = 1;

// ── State ──────────────────────────────────────────────────────────────────────
let concurrency  = CONCURRENCY_INIT;
let running      = true;
let activeCount  = 0;

const results = {
  startTime:    Date.now(),
  config:       { SERVER_URL, HTML_FILE, DURATION_MS, MAX_RESPONSE_MS, MAX_CPU_PCT, MAX_MEM_PCT },
  intervals:    [],   // one entry per calibration window
  requests:     [],   // { startMs, durationMs, status, pages, error }
  summary:      null,
};

// rolling window for calibration decisions
const rtWindow = [];

// ── System metrics ─────────────────────────────────────────────────────────────
function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return Math.round((1 - idle / total) * 100);
}

function memUsagePct() {
  return Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
}

function sysStats() {
  return { cpuPct: cpuUsage(), memPct: memUsagePct(), rssGB: (process.memoryUsage().rss / 1024 / 1024 / 1024).toFixed(2) };
}

// ── HTTP request ───────────────────────────────────────────────────────────────
const fileBuffer = fs.readFileSync(HTML_FILE);
const fileName   = path.basename(HTML_FILE);

async function convertRequest() {
  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: 'text/html' });
  form.append('htmlfile', blob, fileName);

  const t0  = Date.now();
  let status = 0, pages = 0, error = null;

  try {
    const res = await fetch(`${SERVER_URL}/convert`, { method: 'POST', body: form });
    status = res.status;
    if (res.ok) {
      // drain body to measure full round-trip
      const buf = await res.arrayBuffer();
      pages = parseInt(res.headers.get('X-Pages') || '0', 10);
    } else {
      error = `HTTP ${res.status}`;
      await res.text();
    }
  } catch (e) {
    error = e.message;
  }

  const durationMs = Date.now() - t0;
  return { startMs: t0, durationMs, status, pages, error };
}

// ── Calibration ────────────────────────────────────────────────────────────────
function avgRt() {
  if (rtWindow.length === 0) return 0;
  return rtWindow.reduce((a, b) => a + b, 0) / rtWindow.length;
}

function calibrate(intervalStats) {
  const { avgRtMs, cpuPct, memPct, successRate } = intervalStats;
  const old = concurrency;

  const overloaded = avgRtMs > RT_SCALE_DOWN_MS || cpuPct > MAX_CPU_PCT || memPct > MAX_MEM_PCT;
  const healthy    = avgRtMs < RT_SCALE_UP_MS   && cpuPct < MAX_CPU_PCT * 0.8 && memPct < MAX_MEM_PCT * 0.8 && successRate === 1;

  if (overloaded && concurrency > CONCURRENCY_MIN) {
    concurrency = Math.max(CONCURRENCY_MIN, Math.floor(concurrency * 0.7));
  } else if (healthy && concurrency < CONCURRENCY_MAX) {
    concurrency = Math.min(CONCURRENCY_MAX, concurrency + 1);
  }

  return { from: old, to: concurrency, reason: overloaded ? 'scale-down' : healthy ? 'scale-up' : 'hold' };
}

// ── Reporting ──────────────────────────────────────────────────────────────────
function pad(str, n) { return String(str).padEnd(n); }
function ms(n) { return n < 1000 ? `${n}ms` : `${(n/1000).toFixed(1)}s`; }

function printHeader() {
  console.log('\n' + '═'.repeat(90));
  console.log(`  html-to-pdf Load Test  |  File: ${fileName}  |  Duration: 1 hour  |  Target RT < 15s`);
  console.log('═'.repeat(90));
  console.log(pad('Time', 8) + pad('Concur', 8) + pad('ReqsDone', 10) + pad('AvgRT', 9) +
              pad('P95RT', 9) + pad('TPS', 7) + pad('Success', 9) + pad('CPU%', 7) + pad('Mem%', 7) + 'Action');
  console.log('─'.repeat(90));
}

function printRow(elapsed, stats, action) {
  const elStr = `${Math.floor(elapsed / 60000)}m${String(Math.floor((elapsed % 60000) / 1000)).padStart(2,'0')}s`;
  const tpsStr = stats.tps.toFixed(2);
  const successStr = `${(stats.successRate * 100).toFixed(0)}%`;
  console.log(
    pad(elStr, 8) +
    pad(stats.concurrency, 8) +
    pad(stats.totalReqs, 10) +
    pad(ms(Math.round(stats.avgRtMs)), 9) +
    pad(ms(Math.round(stats.p95RtMs)), 9) +
    pad(tpsStr, 7) +
    pad(successStr, 9) +
    pad(stats.cpuPct + '%', 7) +
    pad(stats.memPct + '%', 7) +
    action
  );
}

// ── Worker loop ────────────────────────────────────────────────────────────────
let requestQueue = Promise.resolve();

function spawnWorker() {
  if (!running) return;
  if (activeCount >= concurrency) return;

  activeCount++;
  convertRequest().then(rec => {
    results.requests.push(rec);
    rtWindow.push(rec.durationMs);
    if (rtWindow.length > SAMPLE_WINDOW) rtWindow.shift();
    activeCount--;
    if (running) spawnWorker();
  });
}

function fillWorkers() {
  const slots = concurrency - activeCount;
  for (let i = 0; i < slots; i++) spawnWorker();
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nStarting load test → ${SERVER_URL}`);
  console.log(`File: ${HTML_FILE} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Duration: 1 hour  |  Calibrate every: ${CALIBRATE_EVERY_MS / 1000}s\n`);

  printHeader();

  const startMs  = Date.now();
  let lastCalMs  = startMs;
  let lastReqIdx = 0;

  // fill initial workers
  fillWorkers();

  const calibrateTimer = setInterval(() => {
    if (!running) return;

    const now     = Date.now();
    const elapsed = now - startMs;
    const window  = results.requests.slice(lastReqIdx);
    lastReqIdx    = results.requests.length;

    const windowMs   = now - lastCalMs;
    lastCalMs        = now;

    const ok         = window.filter(r => !r.error && r.status === 200);
    const avgRtMs    = ok.length ? ok.reduce((a, r) => a + r.durationMs, 0) / ok.length : 0;
    const sorted     = [...ok].sort((a, b) => a.durationMs - b.durationMs);
    const p95RtMs    = sorted.length ? sorted[Math.floor(sorted.length * 0.95)].durationMs : 0;
    const tps        = ok.length / (windowMs / 1000);
    const successRate = window.length ? ok.length / window.length : 1;
    const sys        = sysStats();

    const intervalStats = {
      timestamp: new Date().toISOString(),
      elapsed,
      concurrency,
      windowReqs: window.length,
      totalReqs: results.requests.length,
      avgRtMs,
      p95RtMs,
      tps,
      successRate,
      ...sys,
    };

    const adj = calibrate(intervalStats);
    intervalStats.calibration = adj;
    results.intervals.push(intervalStats);

    const actionStr = adj.reason === 'scale-down' ? `↓ ${adj.from}→${adj.to} (overloaded)`
                    : adj.reason === 'scale-up'   ? `↑ ${adj.from}→${adj.to} (healthy)`
                    :                               '— hold';

    printRow(elapsed, intervalStats, actionStr);

    // spawn new workers if concurrency increased
    fillWorkers();

  }, CALIBRATE_EVERY_MS);

  // fill workers continuously
  const fillTimer = setInterval(() => { if (running) fillWorkers(); }, 500);

  // stop after duration
  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  running = false;
  clearInterval(calibrateTimer);
  clearInterval(fillTimer);

  // wait for in-flight requests (max 20s)
  const drainStart = Date.now();
  while (activeCount > 0 && Date.now() - drainStart < 20_000) {
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Final summary ────────────────────────────────────────────────────────────
  const allOk    = results.requests.filter(r => !r.error && r.status === 200);
  const allSorted = [...allOk].sort((a, b) => a.durationMs - b.durationMs);
  const totalSec = (Date.now() - startMs) / 1000;

  results.summary = {
    totalRequests:   results.requests.length,
    successRequests: allOk.length,
    failedRequests:  results.requests.length - allOk.length,
    successRate:     (allOk.length / results.requests.length * 100).toFixed(1) + '%',
    avgRtMs:         allOk.length ? Math.round(allOk.reduce((a, r) => a + r.durationMs, 0) / allOk.length) : 0,
    p50RtMs:         allSorted[Math.floor(allSorted.length * 0.50)]?.durationMs ?? 0,
    p95RtMs:         allSorted[Math.floor(allSorted.length * 0.95)]?.durationMs ?? 0,
    p99RtMs:         allSorted[Math.floor(allSorted.length * 0.99)]?.durationMs ?? 0,
    maxRtMs:         allSorted[allSorted.length - 1]?.durationMs ?? 0,
    minRtMs:         allSorted[0]?.durationMs ?? 0,
    overallTps:      (allOk.length / totalSec).toFixed(3),
    peakConcurrency: Math.max(...results.intervals.map(i => i.concurrency)),
    durationSec:     Math.round(totalSec),
  };

  const sep = '═'.repeat(55);
  console.log('\n' + sep);
  console.log('  FINAL SUMMARY');
  console.log(sep);
  const s = results.summary;
  const rows = [
    ['Total Requests',   s.totalRequests],
    ['Successful',       s.successRequests],
    ['Failed',          s.failedRequests],
    ['Success Rate',    s.successRate],
    ['Overall TPS',     s.overallTps],
    ['Peak Concurrency',s.peakConcurrency],
    ['Avg Response',    ms(s.avgRtMs)],
    ['P50 Response',    ms(s.p50RtMs)],
    ['P95 Response',    ms(s.p95RtMs)],
    ['P99 Response',    ms(s.p99RtMs)],
    ['Max Response',    ms(s.maxRtMs)],
    ['Min Response',    ms(s.minRtMs)],
    ['Duration',        s.durationSec + 's'],
  ];
  for (const [k, v] of rows) {
    console.log(`  ${pad(k, 20)} ${v}`);
  }
  console.log(sep + '\n');

  // save report
  const outFile = path.join(__dirname, `results-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`Full report saved → ${outFile}\n`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
