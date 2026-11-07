/**
 * Main application tests (node --test).
 * Covers: public routes, contact GET/POST, missing/invalid values, oversized
 * body handling, template/partial rendering, and SEO file behaviour.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

let server;
let base;

before(async () => {
  delete process.env.PUBLIC_SITE_URL; // ensure no production domain -> sitemap 404
  const app = require('../app');
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('public routes return 200', async () => {
  const ok = ['/', '/about', '/features', '/how-it-works', '/guides',
    '/guides/how-to-download-a-website-for-offline-browsing',
    '/guides/what-is-website-mirroring',
    '/guides/why-offline-copies-look-different',
    '/guides/website-download-troubleshooting',
    '/faq', '/contact', '/privacy', '/terms'];
  for (const p of ok) {
    const res = await fetch(base + p);
    assert.strictEqual(res.status, 200, 'expected 200 for ' + p);
  }
});

test('unknown routes return 404', async () => {
  const res = await fetch(base + '/nope');
  assert.strictEqual(res.status, 404);
});

test('sitemap.xml returns 404 when no PUBLIC_SITE_URL is configured', async () => {
  const res = await fetch(base + '/sitemap.xml');
  assert.strictEqual(res.status, 404);
});

test('robots.txt omits Sitemap line without a configured domain', async () => {
  const res = await fetch(base + '/robots.txt');
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('Sitemap:'), 'robots should not advertise a sitemap URL');
});

test('ads.txt is a placeholder until verified', async () => {
  const res = await fetch(base + '/ads.txt');
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ads.txt'));
});

test('about page renders (partials registered)', async () => {
  const res = await fetch(base + '/about');
  const html = await res.text();
  assert.ok(html.includes('About Website Downloader'));
  assert.ok(html.includes('site-footer'));
});

test('contact GET shows the form', async () => {
  const res = await fetch(base + '/contact');
  const html = await res.text();
  assert.ok(html.includes('id="contact-form"'));
  assert.ok(html.includes('cf-name'));
});

test('contact POST with valid values composes a mailto link (no false delivery claim)', async () => {
  const body = new URLSearchParams({ name: 'Jane', email: 'jane@example.com', message: 'Hello' });
  const res = await fetch(base + '/contact', { method: 'POST', body });
  const html = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(html.includes('Your message is ready to send'));
  assert.ok(html.includes('mailto:'));
  assert.ok(!html.includes('has been recorded'), 'must not claim delivery');
});

test('contact POST with missing values shows an error', async () => {
  const body = new URLSearchParams({ name: '', email: '', message: '' });
  const res = await fetch(base + '/contact', { method: 'POST', body });
  const html = await res.text();
  assert.ok(html.includes('Please fill in all required fields.'));
});

test('oversized body is rejected safely', async () => {
  const huge = 'x'.repeat(1024 * 50);
  const body = new URLSearchParams({ name: huge, email: 'a@b.c', message: 'x' });
  const res = await fetch(base + '/contact', { method: 'POST', body });
  assert.strictEqual(res.status, 413);
});
