/**
 * HTTP download API regression tests (node --test).
 * Covers: URL validation, SSRF/blocked-host rejection, rate limiting, and a
 * real streaming ZIP download.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

let server;
let base;

before(async () => {
  const app = require('../app');
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

function post(url) {
  return fetch(base + '/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

test('rejects non-http(s) schemes', async () => {
  for (const u of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
    const res = await post(u);
    assert.strictEqual(res.status, 400, 'expected 400 for ' + u);
  }
});

test('rejects local/private hosts and literal private IPs', async () => {
  for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/']) {
    const res = await post(u);
    assert.strictEqual(res.status, 400, 'expected 400 for ' + u);
  }
});

test('streams a real ZIP for a small public site', { timeout: 30000 }, async () => {
  const res = await post('https://example.com');
  assert.strictEqual(res.status, 200, 'expected 200');
  assert.ok((res.headers.get('content-type') || '').includes('application/zip'));
  assert.ok((res.headers.get('content-disposition') || '').includes('attachment'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 0, 'zip should not be empty');
  assert.ok(buf.slice(0, 2).equals(Buffer.from('PK', 'ascii')), 'expected ZIP magic bytes');
});

test('rate limits http download creation', async () => {
  let saw429 = false;
  for (let i = 0; i < 21; i++) {
    const res = await post('javascript:alert(1)');
    if (res.status === 429) { saw429 = true; break; }
    assert.strictEqual(res.status, 400, 'expected 400 on attempt ' + i);
  }
  assert.ok(saw429, 'expected a 429 after exceeding the limit');
});
