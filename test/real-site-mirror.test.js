/**
 * Real-site mirror regression tests (node --test).
 *
 * Exercises the restored Wget engine end-to-end through the Vercel-compatible
 * worker proxy: create job -> poll -> download, then verifies the returned ZIP
 * actually contains HTML, CSS, JavaScript and image assets with the site's
 * directory structure (not just HTTP 200 / ZIP magic bytes).
 *
 * Also asserts the removed basic HTTP fetcher (/api/download) no longer exists.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'test-key-real-site';
let worker;
let workerBase;
let archiveDir;
let server;
let appBase;

function listZipEntries(buf) {
  const entries = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return entries;
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

before(async () => {
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-mirror-test-'));

  // 1. Start the worker (the Wget engine).
  process.env.WORKER_API_KEY = KEY;
  process.env.WORKER_CORS_ORIGIN = 'http://allowed.example';
  process.env.ARCHIVE_DIR = archiveDir;
  const { createWorkerApp } = require('../worker/server');
  const workerApp = createWorkerApp();
  worker = workerApp.listen(0);
  await new Promise((resolve) => worker.on('listening', resolve));
  workerBase = 'http://127.0.0.1:' + worker.address().port;

  // 2. Start the app wired to that worker (proxy mode). The worker loads
  //     ../config before WORKER_URL is known, so purge the cached config/app
  //     modules so they re-evaluate with the real worker URL (otherwise the
  //     /api/jobs proxy is never mounted).
  process.env.WORKER_URL = workerBase;
  process.env.WORKER_API_KEY = KEY;
  for (const id of Object.keys(require.cache)) {
    if (/\\(config|app)\.js$/.test(id)) delete require.cache[id];
  }
  const app = require('../app');
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  appBase = 'http://127.0.0.1:' + server.address().port;
});

after(() => {
  return new Promise((resolve) => {
    const close = () => {
      try { fs.rmSync(archiveDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
      resolve();
    };
    if (server) server.close(() => { if (worker) worker.close(close); else close(); });
    else if (worker) worker.close(close);
    else close();
  });
});

test('basic HTTP fetcher /api/download is removed (404)', { timeout: 15000 }, async () => {
  const res = await fetch(appBase + '/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.strictEqual(res.status, 404, 'expected the basic fetcher route to be gone');
});

test('worker proxy mirrors a real multi-asset site into a ZIP (appgallop.com)', { timeout: 180000 }, async () => {
  const create = await fetch(appBase + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.appgallop.com/' }),
  });
  assert.strictEqual(create.status, 202, 'expected 202 create');
  const job = await create.json();
  assert.ok(job.id, 'job id present');

  let state = null;
  for (let i = 0; i < 160; i++) {
    const r = await fetch(appBase + '/api/jobs/' + job.id);
    state = await r.json();
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.strictEqual(state.status, 'completed', 'job completed, got: ' + JSON.stringify(state));

  const dl = await fetch(appBase + '/api/jobs/' + job.id + '/download');
  assert.strictEqual(dl.status, 200);
  assert.ok((dl.headers.get('content-type') || '').includes('application/zip'));

  const buf = Buffer.from(await dl.arrayBuffer());
  assert.ok(buf.slice(0, 2).equals(Buffer.from('PK', 'ascii')), 'ZIP magic bytes');
  const entries = listZipEntries(buf);
  assert.ok(entries.length >= 4, 'expected a multi-file mirror, got ' + JSON.stringify(entries));

  // Real assets present: HTML, CSS, JS and an image.
  assert.ok(entries.some((n) => /\.(html?|xhtml)$/.test(n.toLowerCase())), 'HTML entry present');
  assert.ok(entries.some((n) => n.toLowerCase().endsWith('.css')), 'CSS entry present');
  assert.ok(entries.some((n) => n.toLowerCase().endsWith('.js')), 'JS entry present');
  assert.ok(entries.some((n) => /\.(png|jpe?g|gif|svg|webp|ico|avif)$/.test(n.toLowerCase())), 'image asset present');

  // Directory structure mirrors the host.
  assert.ok(entries.some((n) => n.startsWith('www.appgallop.com/')), 'host directory prefix present');
});
