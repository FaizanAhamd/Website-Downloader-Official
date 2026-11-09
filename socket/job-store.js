/**
 * socket/job-store.js — classic Socket.IO job state, decoupled from any single
 * socket connection.
 *
 * WHY THIS EXISTS
 * ---------------
 * Previously a download was bound to the live socket object: on disconnect the
 * server cancelled the running job and the client permanently showed a failure.
 * A brief transport drop (mobile network, proxy idle timeout) therefore lost a
 * perfectly good download even after its ZIP had been written.
 *
 * This store keeps job state independent of the connection, so a running job
 * survives disconnects and can be recovered later via the `sync` handshake:
 *
 *   client  --request(token)--> server starts job, stores state
 *   ... network blip ...
 *   server  job continues (NOT cancelled)
 *   client  reconnects, --sync(token)--> server replays current snapshot
 *
 * The ZIP itself lives in the archive directory (managed by archiver + the TTL
 * sweeper) and is only removed after a successful download, so a recovered job
 * can still offer a working download URL for the configured TTL.
 */
'use strict';

function createJobStore(opts) {
  const options = opts || {};
  const ttlMs = options.ttlMs || 10 * 60 * 1000; // recovery window
  const jobs = new Map();

  function create(token, extra) {
    const job = {
      token: token,
      status: 'starting',
      file: '',
      files: 0,
      error: null,
      url: '',
      log: '',
      events: [],
      lastPayload: null,
      handle: null,            // engine control handle (cancel)
      subscriber: null,        // currently-attached socket (may be null)
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    };
    if (extra && extra.subscriber) job.subscriber = extra.subscriber;
    jobs.set(token, job);
    return job;
  }

  function get(token) {
    return jobs.get(token) || null;
  }

  function all() {
    return Array.from(jobs.values());
  }

  function attach(token, handle) {
    const job = get(token);
    if (job) { job.handle = handle; job.updatedAt = Date.now(); }
  }

  /** Detach a socket without touching the job — the download keeps running. */
  function detachBySubscriber(subscriber) {
    for (const job of jobs.values()) {
      if (job.subscriber === subscriber) {
        job.subscriber = null;
        job.updatedAt = Date.now();
      }
    }
  }

  function applyEvent(token, payload) {
    const job = get(token);
    if (!job) return null;
    job.events.push(payload);
    job.lastPayload = payload;

    if (payload && payload.error) {
      job.status = 'failed';
      job.error = String(payload.error);
      job.completedAt = Date.now();
    } else if (payload && payload.progress === 'Completed') {
      job.status = 'completed';
      job.file = String(payload.file || '');
      job.files = typeof payload.files === 'number' ? payload.files : job.files;
      job.url = String(payload.url || '');
      job.completedAt = Date.now();
    } else if (payload && payload.progress === 'Converting') {
      job.status = 'converting';
    } else if (payload && payload.progress === 'Starting') {
      job.status = 'running';
    } else if (payload && typeof payload.progress === 'string' && payload.progress) {
      job.status = 'running';
      job.log = (job.log ? job.log + '\n' : '') + payload.progress;
    }

    job.updatedAt = Date.now();
    return job;
  }

  function markCancelled(token) {
    const job = get(token);
    if (job) {
      job.status = 'cancelled';
      job.error = 'Download cancelled.';
      job.lastPayload = { error: 'Download cancelled.' };
      job.completedAt = Date.now();
      job.updatedAt = Date.now();
    }
  }

  /** A minimal, idempotent snapshot the client can redraw after reconnecting. */
  function snapshot(job) {
    if (!job) return null;
    switch (job.status) {
      case 'completed':
        return { progress: 'Completed', file: job.file, files: job.files, url: job.url };
      case 'failed':
        return { error: job.error || 'Download failed.' };
      case 'cancelled':
        return { error: 'Download cancelled.' };
      case 'converting':
        return { progress: 'Converting' };
      case 'running':
        return job.log
          ? { progress: job.log.split('\n').slice(-5).join('\n') }
          : { progress: 'Starting' };
      default:
        return { progress: 'Starting' };
    }
  }

  function sweep() {
    const now = Date.now();
    for (const [token, job] of jobs) {
      if (now - job.createdAt > ttlMs) jobs.delete(token);
    }
  }

  const interval = setInterval(sweep, Math.min(ttlMs, 60 * 1000));
  if (interval.unref) interval.unref();

  return {
    create: create,
    get: get,
    all: all,
    attach: attach,
    detachBySubscriber: detachBySubscriber,
    applyEvent: applyEvent,
    markCancelled: markCancelled,
    snapshot: snapshot,
    sweep: sweep,
    close: function () { clearInterval(interval); },
  };
}

module.exports = { create: createJobStore };
