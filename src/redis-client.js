'use strict';

/**
 * In-memory Redis-compatible client.
 * Implements only the subset we need: hset/hget/hgetall/del, setex/get,
 * lpush/rpop/llen, publish/subscribe.
 * Auto-falls back to real ioredis if REDIS_URL is set.
 */

let redisClient = null;

// ── In-memory implementation ───────────────────────────────────────────────────
class MemoryRedis {
  constructor() {
    this._hashes  = new Map(); // key → Map<field, value>
    this._strings = new Map(); // key → { value, expiresAt }
    this._lists   = new Map(); // key → value[]
    this._subs    = new Map(); // channel → Set<callback>
    // Expire scanner (every 5s)
    this._expirer = setInterval(() => this._pruneExpired(), 5000).unref();
  }

  _pruneExpired() {
    const now = Date.now();
    for (const [k, v] of this._strings) {
      if (v.expiresAt && v.expiresAt < now) this._strings.delete(k);
    }
  }

  // ── Hash ──────────────────────────────────────────────────────────────────────
  async hset(key, ...args) {
    if (!this._hashes.has(key)) this._hashes.set(key, new Map());
    const h = this._hashes.get(key);
    // args can be (field, value) or (field, value, field, value, ...)
    // ioredis also accepts an object as second arg
    if (args.length === 1 && typeof args[0] === 'object') {
      for (const [f, v] of Object.entries(args[0])) h.set(f, String(v));
    } else {
      for (let i = 0; i < args.length; i += 2) h.set(args[i], String(args[i + 1]));
    }
    return 'OK';
  }
  async hget(key, field) {
    return this._hashes.get(key)?.get(field) ?? null;
  }
  async hgetall(key) {
    const h = this._hashes.get(key);
    if (!h) return null;
    return Object.fromEntries(h);
  }
  async hdel(key, ...fields) {
    const h = this._hashes.get(key);
    if (!h) return 0;
    let count = 0;
    for (const f of fields) if (h.delete(f)) count++;
    return count;
  }

  // ── String ────────────────────────────────────────────────────────────────────
  async set(key, value, ...opts) {
    // opts: ['EX', seconds] or ['PX', ms]
    let expiresAt = null;
    for (let i = 0; i < opts.length; i += 2) {
      if (opts[i] === 'EX')  expiresAt = Date.now() + opts[i+1] * 1000;
      if (opts[i] === 'PX')  expiresAt = Date.now() + opts[i+1];
    }
    this._strings.set(key, { value: String(value), expiresAt });
    return 'OK';
  }
  async setex(key, seconds, value) {
    return this.set(key, value, 'EX', seconds);
  }
  async get(key) {
    const entry = this._strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this._strings.delete(key);
      return null;
    }
    return entry.value;
  }
  async del(...keys) {
    let count = 0;
    for (const k of keys) {
      if (this._strings.delete(k) || this._hashes.delete(k) || this._lists.delete(k)) count++;
    }
    return count;
  }
  async expire(key, seconds) {
    const entry = this._strings.get(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
    return entry ? 1 : 0;
  }
  async exists(...keys) {
    return keys.filter(k =>
      this._strings.has(k) || this._hashes.has(k) || this._lists.has(k)
    ).length;
  }

  // ── List ──────────────────────────────────────────────────────────────────────
  async lpush(key, ...values) {
    if (!this._lists.has(key)) this._lists.set(key, []);
    const l = this._lists.get(key);
    for (const v of values) l.unshift(v);
    return l.length;
  }
  async rpush(key, ...values) {
    if (!this._lists.has(key)) this._lists.set(key, []);
    const l = this._lists.get(key);
    for (const v of values) l.push(v);
    return l.length;
  }
  async rpop(key) {
    const l = this._lists.get(key);
    if (!l || l.length === 0) return null;
    return l.pop();
  }
  async llen(key) {
    return this._lists.get(key)?.length ?? 0;
  }
  async lrange(key, start, end) {
    const l = this._lists.get(key) ?? [];
    const e = end === -1 ? l.length : end + 1;
    return l.slice(start, e);
  }

  // ── Pub/Sub ───────────────────────────────────────────────────────────────────
  async publish(channel, message) {
    const subs = this._subs.get(channel);
    if (subs) for (const cb of subs) cb(message);
    return subs?.size ?? 0;
  }
  // Returns a fake subscriber object
  duplicate() {
    const parent = this;
    return {
      _channels: new Set(),
      _handlers: [],
      async subscribe(...channels) {
        for (const ch of channels) {
          this._channels.add(ch);
          if (!parent._subs.has(ch)) parent._subs.set(ch, new Set());
          const handler = (msg) => {
            for (const fn of this._handlers) fn(ch, msg);
          };
          parent._subs.get(ch).add(handler);
          this._handler = handler;
        }
      },
      on(event, fn) { if (event === 'message') this._handlers.push(fn); },
      async unsubscribe() {
        for (const ch of this._channels) {
          parent._subs.get(ch)?.delete(this._handler);
        }
      },
      async disconnect() { await this.unsubscribe(); },
    };
  }

  async disconnect() { clearInterval(this._expirer); }
  async quit()       { return this.disconnect(); }
  async ping()       { return 'PONG'; }
  async flushall()   { this._hashes.clear(); this._strings.clear(); this._lists.clear(); }
}

// ── Factory ────────────────────────────────────────────────────────────────────
function getRedisClient() {
  if (redisClient) return redisClient;

  if (process.env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      redisClient = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
      console.log(`Redis: connected to ${process.env.REDIS_URL}`);
    } catch {
      console.warn('Redis: ioredis failed, falling back to in-memory');
      redisClient = new MemoryRedis();
    }
  } else {
    redisClient = new MemoryRedis();
    console.log('Redis: using in-memory store (set REDIS_URL for persistent Redis)');
  }

  return redisClient;
}

module.exports = { getRedisClient, MemoryRedis };
