/**
 * HTTP download API regression tests (node --test).
 * Covers: URL validation, SSRF/blocked-host rejection, rate limiting, and the
 * recursive mirror (HTML + CSS url() + nested assets, directory structure).
 * Includes an end-to-end multi-asset verification against a real public site.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { extractHtmlAssets, extractCssUrls, resourceName } = require('../routes/download-api')._internals;

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

// ---- URL validation / SSRF / rate limit ----

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

// ---- Mirror algorithm (deterministic, no network) ----

test('extractHtmlAssets finds same-origin href/src and inline url()', () => {
  const base = 'https://example.com/page/index.html';
  const html = `
    <link rel="stylesheet" href="/css/site.css">
    <script src="../js/app.js"></script>
    <img src="/img/logo.png">
    <div style="background:url('/img/bg.jpg')"></div>
    <script src="https://other.example.com/evil.js"></script>
    <img src="data:image/png;base64,AAAA">
  `;
  const found = extractHtmlAssets(html, base);
  const hrefs = found.map((u) => new URL(u).pathname);
  for (const expect of ['/css/site.css', '/js/app.js', '/img/logo.png', '/img/bg.jpg']) {
    assert.ok(hrefs.includes(expect), 'missing ' + expect + ' in ' + JSON.stringify(hrefs));
  }
  // cross-origin and data: must be excluded
  assert.ok(!found.some((u) => u.includes('other.example.com')));
  assert.ok(!found.some((u) => u.startsWith('data:')));
});

test('extractCssUrls resolves url() references and skips data:', () => {
  const base = 'https://example.com/css/site.css';
  const css = `
    @font-face { src: url('../fonts/site.woff2'); }
    .a { background: url("/img/a.png"); }
    .b { background-image: url('img/b.png'); }
    .c { background: url(data:image/svg+xml;base64,xx); }
  `;
  const found = extractCssUrls(css, base);
  const hrefs = found.map((u) => new URL(u).pathname);
  assert.ok(hrefs.includes('/fonts/site.woff2'), JSON.stringify(hrefs));
  assert.ok(hrefs.includes('/img/a.png'));
  assert.ok(hrefs.includes('/css/img/b.png'));
  assert.ok(!found.some((u) => u.startsWith('data:')));
});

test('resourceName preserves directory structure and falls back by content type', () => {
  assert.strictEqual(resourceName('example.com', 'https://example.com/', 'text/html'), 'example.com/index.html');
  assert.strictEqual(resourceName('example.com', 'https://example.com/css/site.css', 'text/css'), 'example.com/css/site.css');
  assert.strictEqual(resourceName('example.com', 'https://example.com/about/', 'text/html'), 'example.com/about/index.html');
  // no extension -> classified from content type
  assert.strictEqual(resourceName('example.com', 'https://example.com/blob', 'image/png'), 'example.com/blob.png');
  // sanitized segments (path is URL-encoded; query stripped; extension falls
  // back to content type)
  assert.strictEqual(resourceName('example.com', 'https://example.com/a%20b/c?.txt', 'text/plain'), 'example.com/a_20b/c.txt');
});

// ---- End-to-end multi-asset mirror (real site) ----

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

test('mirrors a real multi-asset site (HTML + CSS + JS/images) with structure', { timeout: 60000 }, async () => {
  const candidates = [
    'https://www.iana.org/help/example-domains',
    'https://www.w3.org/',
  ];
  let lastError = null;
  for (const url of candidates) {
    try {
      const res = await post(url);
      if (res.status !== 200) { lastError = 'status ' + res.status; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const names = listZipEntries(buf);
      assert.ok(names.length >= 3, 'expected a multi-file mirror for ' + url + ' got ' + JSON.stringify(names));
      assert.ok(names.some((n) => n.endsWith('.html') || n.endsWith('/index.html')), 'expected an HTML entry');
      assert.ok(names.some((n) => n.endsWith('.css')), 'expected a CSS entry in ' + JSON.stringify(names));
      const hasJsOrImg = names.some((n) => n.endsWith('.js') || /\.(png|jpg|gif|svg|ico|webp)$/.test(n));
      assert.ok(hasJsOrImg, 'expected a JS or image asset in ' + JSON.stringify(names));
      return; // success
    } catch (e) {
      lastError = e.message;
    }
  }
  assert.fail('no candidate produced a valid multi-asset mirror: ' + lastError);
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
