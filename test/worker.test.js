/**
 * Worker API tests (node --test).
 * Covers: auth, CORS allowlisting, job lifecycle (create/poll/download/delete),
 * URL scheme validation, and rate-limit behaviour.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'test-key-123';
let server;
let base;
let archiveDir;

before(async () => {
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-worker-test-'));
  process.env.WORKER_API_KEY = KEY;
  process.env.WORKER_CORS_ORIGIN = 'http://allowed.example';
  process.env.ARCHIVE_DIR = archiveDir;
  const { createWorkerApp } = require('../worker/server');
  const app = createWorkerApp();
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => {
  return new Promise((resolve) => {
    if (server) server.close(() => { fs.rmSync(archiveDir, { recursive: true, force: true }); resolve(); });
    else resolve();
  });
});

function authHeaders() {
  return { Authorization: 'Bearer ' + KEY };
}

test('healthz is open', async () => {
  const res = await fetch(base + '/healthz');
  assert.strictEqual(res.status, 200);
});

test('API requires a valid bearer key', async () => {
  const noAuth = await fetch(base + '/api/jobs/does-not-exist');
  assert.strictEqual(noAuth.status, 401);
  const badAuth = await fetch(base + '/api/jobs/does-not-exist', { headers: { Authorization: 'Bearer wrong' } });
  assert.strictEqual(badAuth.status, 401);
  const goodAuth = await fetch(base + '/api/jobs/does-not-exist', { headers: authHeaders() });
  assert.strictEqual(goodAuth.status, 404);
});

test('CORS allowlists origins and rejects others', async () => {
  // Allowed origin preflight.
  const ok = await fetch(base + '/api/jobs', {
    method: 'OPTIONS',
    headers: { Origin: 'http://allowed.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.strictEqual(ok.status, 204);
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'http://allowed.example');

  // Disallowed origin preflight.
  const denied = await fetch(base + '/api/jobs', {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.strictEqual(denied.status, 403);
});

test('rejects non-http(s) schemes', async () => {
  for (const url of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'localhost']) {
    const res = await fetch(base + '/api/jobs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ url }),
    });
    assert.strictEqual(res.status, 400, 'expected 400 for ' + url);
  }
});

test('end-to-end job lifecycle (network): create -> poll -> completed -> download -> delete', { timeout: 60000 }, async () => {
  const create = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.strictEqual(create.status, 202);
  const job = await create.json();
  assert.ok(job.id);

  // Poll until terminal.
  let state = null;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(base + '/api/jobs/' + job.id, { headers: authHeaders() });
    state = await r.json();
    if (state.status === 'completed' || state.status === 'failed') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.strictEqual(state.status, 'completed', 'job failed: ' + JSON.stringify(state));
  assert.ok(state.files >= 1);
  assert.ok(state.file && state.file.endsWith('.zip'));
  assert.strictEqual(state.downloadUrl, '/api/jobs/' + job.id + '/download');

  // Download the archive.
  const dl = await fetch(base + '/api/jobs/' + job.id + '/download', { headers: authHeaders() });
  assert.strictEqual(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.ok(buf.length > 0);
  assert.ok(buf.slice(0, 2).equals(Buffer.from('PK', 'ascii')), 'expected ZIP magic bytes');

  // Archive removed after download.
  const jobPath = path.join(archiveDir, state.file);
  assert.ok(!fs.existsSync(jobPath), 'archive should be deleted after download');
});

test('cancel endpoint marks a job cancelled', async () => {
  const create = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  const job = await create.json();
  const cancel = await fetch(base + '/api/jobs/' + job.id + '/cancel', {
    method: 'POST',
    headers: authHeaders(),
  });
  assert.strictEqual(cancel.status, 200);
  const body = await cancel.json();
  assert.strictEqual(body.status, 'cancelled');
});

test('rate limits job creation (no real jobs spawned)', async () => {
  // A burst of invalid-scheme POSTs must eventually yield 429 (the rate limit
  // is enforced before scheme validation, and keyed on the peer address).
  let saw429 = false;
  for (let i = 0; i < 21; i++) {
    const res = await fetch(base + '/api/jobs', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ url: 'javascript:alert(1)' }),
    });
    if (res.status === 429) { saw429 = true; break; }
    assert.strictEqual(res.status, 400, 'expected 400 on attempt ' + i);
  }
  assert.ok(saw429, 'expected 429 after exceeding limit');
});
