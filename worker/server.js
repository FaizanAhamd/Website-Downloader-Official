/**
 * worker/server.js — standalone, always-on download worker.
 *
 * Reuses the hardened engine (wget/index.js, archiver/index.js) and exposes an
 * HTTP polling API. This service is separate from the Vercel app because a
 * serverless function cannot run Wget or hold a long-running job.
 *
 * Security:
 *   - API-key authentication (WORKER_API_KEY) is REQUIRED on every /api/jobs*
 *     endpoint. The key is an environment secret and is never sent to browsers.
 *   - Strict CORS: only origins listed in WORKER_CORS_ORIGIN (comma-separated)
 *     are allowed; otherwise no cross-origin access. No arbitrary origins.
 *   - SSRF protection is enforced by the engine (private/link-local/loopback/
 *     cloud-metadata IPv4+IPv6, DNS-pinned, redirect-destination guard) before
 *     and during Wget, plus a synchronous http(s)-only scheme check here.
 *   - Rate limiting (memory-bounded) on job creation, keyed on the socket peer
 *     address only (X-Forwarded-For is never trusted).
 *   - If ARCHIVE_UPLOAD_URL is set, a job is only "completed" after the archive
 *     upload succeeds; on failure the job is marked failed and the temp file is
 *     cleaned up.
 *
 * Run:  node worker/server.js   (PORT defaults to 3200)
 */
'use strict';

/* eslint-disable no-console */

try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

var express = require('express');
var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var wget = require('../wget');
var downloadCfg = require('../config').download;
var createRateLimit = require('../lib/rate-limit');
var clientIp = require('../lib/client-ip');

var MAX_CONCURRENT = downloadCfg.maxConcurrent;
var TTL_MS = downloadCfg.zipTtlHours * 3600 * 1000;
var API_KEY = process.env.WORKER_API_KEY || '';
var UPLOAD_URL = process.env.ARCHIVE_UPLOAD_URL || '';
var CORS_ORIGINS = (process.env.WORKER_CORS_ORIGIN || '')
  .split(',')
  .map(function (s) { return s.trim().replace(/\/$/, ''); })
  .filter(Boolean);

function configArchiveDir() {
  return process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'private', 'archives');
}

function trustProxySetting() {
  var v = (process.env.TRUST_PROXY || '').trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

var activeJobs = 0;
var jobs = new Map();
var jobCreateLimit = createRateLimit({ windowMs: 60 * 1000, max: 20, maxEntries: 1000 });

function now() { return Date.now(); }

/* ---------------- Job model ---------------- */

function applyEvent(job, payload) {
  job.events.push(payload);
  if (payload.error) {
    job.status = 'failed';
    job.error = String(payload.error);
  } else if (payload.progress === 'Completed') {
    job.file = String(payload.file || '');
    job.files = typeof payload.files === 'number' ? payload.files : job.files;
    // If an upload is configured, completion is deferred until the upload
    // succeeds. Otherwise complete immediately.
    if (UPLOAD_URL) {
      job.status = 'uploading';
      maybeUploadAfterComplete(job);
    } else {
      job.status = 'completed';
      job.completedAt = now();
      console.log('[job ' + job.id + '] status=completed file=' + job.file +
        ' files=' + job.files + ' url=/api/jobs/' + job.id + '/download');
    }
  } else if (payload.progress === 'Converting') {
    job.status = 'converting';
  } else if (payload.progress === 'Starting') {
    job.status = 'running';
  } else if (typeof payload.progress === 'string' && payload.progress) {
    job.status = 'running';
    job.log = (job.log ? job.log + '\n' : '') + payload.progress;
  }
}

function makeSocket(job) {
  return { emit: function (token, payload) { applyEvent(job, payload); } };
}

function createJob(url) {
  var id = crypto.randomBytes(8).toString('hex');
  var job = {
    id: id,
    url: url,
    status: 'queued',
    log: '',
    files: 0,
    file: '',
    error: null,
    events: [],
    createdAt: now(),
    completedAt: null,
    control: null,
  };
  jobs.set(id, job);
  return job;
}

function startJob(job) {
  if (activeJobs >= MAX_CONCURRENT) {
    job.status = 'failed';
    job.error = 'Too many downloads are running right now. Please try again in a moment.';
    return;
  }
  activeJobs++;
  job.status = 'running';
  job.control = wget(makeSocket(job), { website: job.url, token: job.id }, function () {
    activeJobs = Math.max(0, activeJobs - 1);
    job.control = null;
  });
}

/* ---------------- Optional archive upload ---------------- */

function maybeUploadAfterComplete(job) {
  var zipPath = path.join(configArchiveDir(), job.file);
  fs.readFile(zipPath, function (err, data) {
    if (err) {
      job.status = 'failed';
      job.error = 'Archive upload failed: could not read the archive (' + err.message + ').';
      cleanupZipSafe(job.file);
      return;
    }
    fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: data,
    }).then(function (res) {
      if (!res.ok) {
        // 4xx/5xx -> upload failed.
        job.status = 'failed';
        job.error = 'Archive upload failed (HTTP ' + res.status + ').';
        cleanupZipSafe(job.file);
        return;
      }
      job.status = 'completed';
      job.completedAt = now();
    }).catch(function (e) {
      job.status = 'failed';
      job.error = 'Archive upload failed: ' + e.message;
      cleanupZipSafe(job.file);
    });
  });
}

function cleanupZipSafe(file) {
  if (!file) return;
  var archiveDir = path.resolve(configArchiveDir());
  var resolved = path.resolve(archiveDir, file);
  if (!resolved.startsWith(archiveDir + path.sep)) return;
  fs.unlink(resolved, function (e) {
    if (e && e.code !== 'ENOENT') console.error('upload-fail cleanup unlink error', e.message);
  });
}

function publicJob(job, baseUrl) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    files: job.files,
    file: job.file,
    error: job.error,
    log: job.log,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    downloadUrl: job.status === 'completed' ? baseUrl + '/api/jobs/' + job.id + '/download' : null,
  };
}

/* ---------------- Sweep ---------------- */

function sweep() {
  var cutoff = now() - TTL_MS;
  jobs.forEach(function (job, id) {
    if (job.status === 'completed' || job.status === 'failed') {
      var ref = job.completedAt || job.createdAt;
      if (ref < cutoff) jobs.delete(id);
    }
  });
}
setInterval(sweep, 60 * 1000).unref();

/* ---------------- App ---------------- */

function createWorkerApp() {
  var app = express();
  app.set('trust proxy', trustProxySetting());
  app.use(express.json({ limit: '32kb' }));

  // Strict CORS allowlisting. Only explicitly allowed origins are honored;
  // disallowed-origin preflights are rejected, and no ACAO header is emitted
  // for arbitrary origins (so browsers block them).
  app.use(function (req, res, next) {
    var origin = req.headers.origin;
    if (origin) {
      var allowed = CORS_ORIGINS.length > 0 && CORS_ORIGINS.indexOf(origin.replace(/\/$/, '')) !== -1;
      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      } else if (req.method === 'OPTIONS') {
        return res.status(403).end();
      }
    } else if (req.method === 'OPTIONS') {
      return res.status(403).end();
    }
    next();
  });

  // Open health check.
  app.get('/healthz', function (req, res) {
    res.json({ ok: true, active: activeJobs, jobs: jobs.size });
  });

  // Required auth for all /api/jobs* endpoints.
  app.use('/api/jobs', function (req, res, next) {
    if (!API_KEY) {
      // Worker not configured with a key: refuse rather than open the API.
      return res.status(503).json({ error: 'Worker authentication is not configured.' });
    }
    var header = req.headers.authorization || '';
    if (header !== 'Bearer ' + API_KEY) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    next();
  });

  app.post('/api/jobs', function (req, res) {
    var ip = clientIp(req);
    if (jobCreateLimit.check(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    var raw = ((req.body && req.body.url) || '').toString().trim();
    var target = wget.parseTarget(raw);
    if (!target) {
      return res.status(400).json({ error: 'url must be a public http(s) address' });
    }
    if (wget.isBlockedHost(target.hostname)) {
      return res.status(400).json({ error: 'url points to a local/private network, which is not allowed' });
    }
    var job = createJob(target.href);
    startJob(job);
    res.status(202).json(publicJob(job, req.baseUrl || ''));
  });

  app.get('/api/jobs/:id', function (req, res) {
    var job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
    res.json(publicJob(job, req.baseUrl || ''));
  });

  app.post('/api/jobs/:id/cancel', function (req, res) {
    var job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
    if (job.control) job.control.cancel();
    job.status = 'cancelled';
    res.json({ id: job.id, status: job.status });
  });

  app.get('/api/jobs/:id/download', function (req, res) {
    var job = jobs.get(req.params.id);
    if (!job || job.status !== 'completed' || !job.file) {
      return res.status(404).json({ error: 'archive not available' });
    }
    var archiveDir = path.resolve(configArchiveDir());
    var resolved = path.resolve(archiveDir, job.file);
    if (!resolved.startsWith(archiveDir + path.sep)) {
      return res.status(404).json({ error: 'bad path' });
    }
    console.log('[job ' + job.id + '] download url=/api/jobs/' + job.id + '/download file=' + job.file);
    res.download(resolved, job.file, function (dlErr) {
      if (dlErr) console.error('[job ' + job.id + '] download failed: ' + dlErr.message);
      fs.unlink(resolved, function (e) {
        if (e && e.code !== 'ENOENT') console.error('[job ' + job.id + '] unlink failed: ' + e.message);
        else if (!e) console.log('[job ' + job.id + '] archive deleted after download: ' + job.file);
      });
    });
  });

  // Ensure archive dir exists.
  fs.mkdirSync(configArchiveDir(), { recursive: true });

  return app;
}

if (require.main === module) {
  if (!API_KEY) {
    console.error('Refusing to start the worker: WORKER_API_KEY is not set. ' +
      'The worker API must never run unauthenticated.');
    process.exit(1);
  }
  var PORT = Number(process.env.PORT) || 3200;
  var app = createWorkerApp();
  app.listen(PORT, function () {
    console.log('Worker listening on http://localhost:' + PORT);
    console.log('Concurrency:', MAX_CONCURRENT, '| TTL hours:', TTL_MS / 3600000);
    console.log('Auth:', API_KEY ? 'enabled' : 'NOT CONFIGURED (API will refuse)');
    console.log('CORS allowlist:', CORS_ORIGINS.length ? CORS_ORIGINS.join(', ') : '(disabled)');
    if (UPLOAD_URL) console.log('Archive upload hook enabled ->', UPLOAD_URL);
  });
}

module.exports = { createWorkerApp: createWorkerApp };
