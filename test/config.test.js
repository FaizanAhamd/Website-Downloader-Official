/**
 * Config validation tests (node --test).
 *
 * Verifies that download resource limits are environment-driven, validated with
 * sensible fallbacks, and never silently accept corrupt values.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Keys that the config reads; reset before each load so the environment cannot
// leak between tests.
const DOWNLOAD_ENV_KEYS = [
  'DOWNLOAD_QUOTA', 'DOWNLOAD_TIMEOUT_MS', 'DOWNLOAD_WATCHDOG_MS',
  'MAX_CONCURRENT_DOWNLOADS', 'MAX_REDIRECTS', 'MAX_CRAWL_DEPTH',
  'ALLOW_CROSS_HOST_REQUISITES', 'DOWNLOAD_ZIP_TTL_HOURS', 'WGET_PATH',
  'ARCHIVE_DIR', 'GA_MEASUREMENT_ID',
];

function loadConfig(env) {
  for (const key of DOWNLOAD_ENV_KEYS) delete process.env[key];
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const cfgPath = require.resolve('../config');
  delete require.cache[cfgPath];
  return require('../config');
}

test('validation helpers parse and fall back correctly', () => {
  const { helpers } = loadConfig({});
  assert.strictEqual(helpers.toPositiveInt('abc', 5), 5);
  assert.strictEqual(helpers.toPositiveInt('12', 5), 12);
  assert.strictEqual(helpers.toPositiveInt('-3', 5), 5);
  assert.strictEqual(helpers.toPositiveInt(0, 5), 5);
  assert.strictEqual(helpers.toNonNegativeInt('0', 9), 0);
  assert.strictEqual(helpers.toNonNegativeInt('-1', 9), 9);
  assert.strictEqual(helpers.toBool('true', false), true);
  assert.strictEqual(helpers.toBool('false', true), false);
  assert.strictEqual(helpers.toBool('', true), true);
  assert.strictEqual(helpers.toBool('1', false), true);
  assert.strictEqual(helpers.parseBytes('500m'), 500 * 1024 * 1024);
  assert.strictEqual(helpers.parseBytes('2g'), 2 * 1024 ** 3);
  assert.strictEqual(helpers.parseBytes('128k'), 128 * 1024);
  assert.strictEqual(helpers.parseBytes('0'), 0);
});

test('download defaults match the documented safe limits', () => {
  const c = loadConfig({});
  assert.strictEqual(c.download.quota, '500m');
  assert.strictEqual(c.download.quotaBytes, 500 * 1024 * 1024);
  assert.strictEqual(c.download.timeoutMs, 900000);
  assert.strictEqual(c.download.watchdogMs, 2000);
  assert.strictEqual(c.download.maxConcurrent, 5);
  assert.strictEqual(c.download.maxRedirects, 10);
  assert.strictEqual(c.download.maxCrawlDepth, 0); // documented default: 0 = unlimited
  assert.strictEqual(c.download.allowCrossHostRequisites, false);
  assert.strictEqual(c.download.zipTtlHours, 24);
});

test('download settings honor valid overrides and reject invalid ones', () => {
  const c = loadConfig({
    DOWNLOAD_QUOTA: '300m',
    DOWNLOAD_TIMEOUT_MS: 'not-a-number',
    MAX_REDIRECTS: '3',
    MAX_CRAWL_DEPTH: '7',
    MAX_CONCURRENT_DOWNLOADS: '-1',
    ALLOW_CROSS_HOST_REQUISITES: 'true',
  });
  assert.strictEqual(c.download.quotaBytes, 300 * 1024 * 1024);
  assert.strictEqual(c.download.timeoutMs, 900000); // invalid -> fallback
  assert.strictEqual(c.download.maxRedirects, 3);
  assert.strictEqual(c.download.maxCrawlDepth, 7);
  assert.strictEqual(c.download.maxConcurrent, 5); // invalid -> fallback
  assert.strictEqual(c.download.allowCrossHostRequisites, true);
});

test('GA4 is disabled by default and enabled only when measurement id is set', () => {
  const noGa = loadConfig({});
  assert.strictEqual(noGa.ga.measurementId, '');

  const withGa = loadConfig({ GA_MEASUREMENT_ID: 'G-YS448FDDN0' });
  assert.strictEqual(withGa.ga.measurementId, 'G-YS448FDDN0');
});
