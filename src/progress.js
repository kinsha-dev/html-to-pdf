'use strict';

function memMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
}

function bar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function eta(startMs, done, total) {
  if (done === 0) return '--';
  const elapsed = (Date.now() - startMs) / 1000;
  const remaining = (elapsed / done) * (total - done);
  if (remaining < 60) return `${remaining.toFixed(0)}s`;
  return `${(remaining / 60).toFixed(1)}m`;
}

class Progress {
  constructor(total, label = 'Chunks') {
    this.total = total;
    this.done = 0;
    this.label = label;
    this.startMs = Date.now();
    this.chunkStart = Date.now();
  }

  tick(msg = '') {
    this.done++;
    const chunkMs = ((Date.now() - this.chunkStart) / 1000).toFixed(1);
    this.chunkStart = Date.now();

    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(0);
    const pct = ((this.done / this.total) * 100).toFixed(0);
    const b = bar(this.done, this.total);
    const remaining = eta(this.startMs, this.done, this.total);
    const mem = memMB();

    process.stdout.write(
      `\r  ${b} ${String(this.done).padStart(3)}/${this.total} ` +
      `${pct}%  elapsed ${elapsed}s  ETA ${remaining}  mem ${mem}MB  chunk ${chunkMs}s` +
      (msg ? `  [${msg}]` : '') +
      '    '
    );

    if (this.done === this.total) process.stdout.write('\n');
  }

  log(msg) {
    process.stdout.write(`\n  ${msg}\n`);
  }
}

module.exports = { Progress };
