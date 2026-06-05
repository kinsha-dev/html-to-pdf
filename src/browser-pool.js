'use strict';

/**
 * Global browser pool — warm Chromium instances reused across requests.
 *
 * Benefits:
 *   - Eliminates ~1.5s cold-start per request
 *   - Caps total Chromium processes at POOL_SIZE (prevents OOM under load)
 *   - Workers queue for a browser instead of spawning new ones
 */

const { chromium } = require('playwright');

const POOL_SIZE = parseInt(process.env.BROWSER_POOL_SIZE || '2');

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--js-flags=--max-old-space-size=384',
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
  '--block-new-web-contents',
];

class BrowserPool {
  constructor(size) {
    this._size      = size;
    this._pool      = [];       // idle browsers
    this._queue     = [];       // pending acquire callbacks
    this._total     = 0;        // total browsers created (idle + in-use)
    this._ready     = false;
    this._warming   = false;
  }

  async warm() {
    if (this._ready || this._warming) return;
    this._warming = true;
    console.log(`BrowserPool: warming ${this._size} browser(s)…`);
    await Promise.all(
      Array.from({ length: this._size }, () => this._spawnAndReturn())
    );
    this._ready = true;
    console.log(`BrowserPool: ready (${this._pool.length} idle)`);
  }

  async _spawn() {
    const b = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    b.on('disconnected', () => {
      this._total--;
      // Replace crashed browser if there are waiters
      if (this._queue.length > 0) {
        this._spawnAndDispatch().catch(() => {});
      }
    });
    this._total++;
    return b;
  }

  async _spawnAndReturn() {
    const b = await this._spawn();
    this._pool.push(b);
  }

  async _spawnAndDispatch() {
    try {
      const b = await this._spawn();
      const next = this._queue.shift();
      if (next) {
        next(b);
      } else {
        this._pool.push(b);
      }
    } catch (err) {
      const next = this._queue.shift();
      if (next) next(null, err);
    }
  }

  // Acquire a browser — waits if all are busy
  async acquire() {
    if (this._pool.length > 0) {
      return this._pool.pop();
    }

    if (this._total < this._size) {
      // Spin up a new browser (up to POOL_SIZE)
      return this._spawn();
    }

    // All browsers in use — wait for one to be released
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this._queue.indexOf(cb);
        if (idx !== -1) this._queue.splice(idx, 1);
        reject(new Error('BrowserPool: acquire timeout after 60s'));
      }, 60_000);

      const cb = (browser, err) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(browser);
      };
      this._queue.push(cb);
    });
  }

  // Return browser to pool (or close if disconnected)
  release(browser) {
    if (!browser.isConnected()) {
      this._total--;
      // Fulfil a waiter with a fresh browser if needed
      if (this._queue.length > 0) {
        this._spawnAndDispatch().catch(() => {});
      }
      return;
    }

    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next(browser);
    } else {
      this._pool.push(browser);
    }
  }

  async closeAll() {
    const all = [...this._pool];
    this._pool.length = 0;
    await Promise.all(all.map(b => b.close().catch(() => {})));
    this._total = 0;
    this._ready = false;
  }

  stats() {
    return { idle: this._pool.length, total: this._total, queued: this._queue.length };
  }
}

// Singleton
const pool = new BrowserPool(POOL_SIZE);
module.exports = { pool };
