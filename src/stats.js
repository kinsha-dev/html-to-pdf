'use strict';

const os = require('os');

function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    for (const val of Object.values(cpu.times)) total += val;
    idle += cpu.times.idle;
  }
  return Math.round((1 - idle / total) * 100);
}

function memoryMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
}

class StatsTracker {
  constructor() {
    this.startTime = Date.now();
    this.startMem = parseFloat(memoryMB());
    this.startCpu = cpuPercent();
    this.peakMem = this.startMem;
    this._interval = setInterval(() => {
      const m = parseFloat(memoryMB());
      if (m > this.peakMem) this.peakMem = m;
    }, 500);
  }

  stop() {
    clearInterval(this._interval);
    return {
      elapsedMs: Date.now() - this.startTime,
      elapsedSec: ((Date.now() - this.startTime) / 1000).toFixed(2),
      startMemMB: this.startMem,
      peakMemMB: this.peakMem,
      endMemMB: parseFloat(memoryMB()),
      cpuPercent: cpuPercent(),
    };
  }
}

module.exports = { StatsTracker };
