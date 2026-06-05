'use strict';

const crypto = require('crypto');
const { getRedisClient } = require('./redis-client');

const QUEUE_KEY    = 'html-pdf:jobs';
const JOB_TTL_SEC  = 3600; // jobs expire after 1 hour
const MAX_ACTIVE   = parseInt(process.env.MAX_CONCURRENT_JOBS || '1');

let activeJobs = 0;
const pending  = []; // local in-process queue (works alongside Redis)

class JobQueue {
  constructor() {
    this._redis = getRedisClient();
  }

  // Create a new job and enqueue it — returns jobId immediately
  async enqueue(meta = {}) {
    const jobId = crypto.randomUUID();
    await this._redis.hset(`job:${jobId}`, {
      id:        jobId,
      status:    'queued',
      createdAt: Date.now(),
      ...meta,
    });
    await this._redis.expire(`job:${jobId}`, JOB_TTL_SEC);
    await this._redis.rpush(QUEUE_KEY, jobId);
    return jobId;
  }

  async setStatus(jobId, status, extra = {}) {
    await this._redis.hset(`job:${jobId}`, { status, updatedAt: Date.now(), ...extra });
    // publish completion so waiters can resolve
    if (status === 'done' || status === 'error') {
      await this._redis.publish(`job:done:${jobId}`, JSON.stringify({ jobId, status, ...extra }));
    }
  }

  async getJob(jobId) {
    return this._redis.hgetall(`job:${jobId}`);
  }

  async queueDepth() {
    return this._redis.llen(QUEUE_KEY);
  }

  // Run fn with a concurrency gate — queues locally if busy
  async run(fn) {
    return new Promise((resolve, reject) => {
      const attempt = async () => {
        if (activeJobs >= MAX_ACTIVE) {
          pending.push(attempt);
          return;
        }
        activeJobs++;
        try   { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
          activeJobs--;
          if (pending.length > 0) pending.shift()();
        }
      };
      attempt();
    });
  }

  activeCount()  { return activeJobs; }
  pendingCount() { return pending.length; }
}

const queue = new JobQueue();
module.exports = { queue };
