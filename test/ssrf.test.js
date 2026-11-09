/**
 * SSRF guard unit tests (node --test).
 *
 * Verifies the blocked-host matcher and the runtime output parser used to stop
 * Wget if a redirect/connection resolves to a private/internal address.
 * Covers IPv4, IPv6, IPv4-mapped IPv6, DNS validation, and public-IP allowlist.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isBlockedHost, findBlockedIpInOutput, parseTarget } = require('../wget');

const blocked = [
  // IPv4 private / link-local / loopback / metadata / reserved
  '127.0.0.1', 'localhost', '10.0.0.1', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
  '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
  // IPv6 loopback / unspecified / ULA / link-local / multicast
  '::1', '::', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0',
  'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1',
  // IPv4-mapped / IPv4-compatible IPv6 wrapping private IPv4
  '::ffff:192.168.1.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  '::ffff:169.254.169.254', '0:0:0:0:0:ffff:192.168.1.1',
  '0:0:0:0:0:ffff:10.0.0.1', '::192.168.1.1',
];

const allowed = [
  // Public IPv4
  '8.8.8.8', '1.1.1.1', '93.184.216.34', 'example.com',
  // Public IPv6
  '2606:4700:4700::1111', '2001:4860:4860::8888',
  '2606:4700:4700::1111', '2a00:1450:4001:810::200e',
  // IPv4-mapped IPv6 wrapping PUBLIC IPv4 must remain allowed
  '::ffff:8.8.8.8', '::ffff:1.1.1.1',
];

test('isBlockedHost rejects private/link-local/loopback/metadata/reserved', () => {
  for (const h of blocked) {
    assert.ok(isBlockedHost(h), 'expected blocked: ' + h);
  }
});

test('isBlockedHost allows public IPv4 and IPv6 hosts', () => {
  for (const h of allowed) {
    assert.ok(!isBlockedHost(h), 'expected allowed: ' + h);
  }
});

test('parseTarget only accepts http(s)', () => {
  assert.ok(parseTarget('https://example.com'));
  assert.ok(parseTarget('http://example.com'));
  assert.ok(parseTarget('8.8.8.8'));
  assert.strictEqual(parseTarget('ftp://example.com'), null);
  assert.strictEqual(parseTarget('javascript:alert(1)'), null);
  assert.strictEqual(parseTarget('file:///etc/passwd'), null);
  assert.strictEqual(parseTarget(''), null);
});

test('findBlockedIpInOutput detects private IPv4 in Wget output', () => {
  const line = 'Connecting to example.com (example.com)|169.254.169.254|:443... connected.';
  assert.strictEqual(findBlockedIpInOutput(line), '169.254.169.254');

  const line2 = 'Resolving internal (internal)... 10.0.0.8\n';
  assert.strictEqual(findBlockedIpInOutput(line2), '10.0.0.8');
});

test('findBlockedIpInOutput detects private and mapped IPv6 in Wget output', () => {
  const loopback = 'Resolving ... 0:0:0:0:0:0:0:1';
  assert.strictEqual(findBlockedIpInOutput(loopback), '0:0:0:0:0:0:0:1');

  const ula = 'Connecting to test (test)|fd12:3456::1|:443...';
  assert.strictEqual(findBlockedIpInOutput(ula), 'fd12:3456::1');

  const mapped = 'Connecting to internal (internal)|::ffff:192.168.1.1|:443...';
  assert.strictEqual(findBlockedIpInOutput(mapped), '::ffff:192.168.1.1');
});

test('findBlockedIpInOutput ignores normal and public-IP output', () => {
  assert.strictEqual(findBlockedIpInOutput('200 OK\nLength: 1963 [text/javascript]'), null);
  assert.strictEqual(findBlockedIpInOutput('Resolving example.com (example.com)... 93.184.216.34'), null);
  assert.strictEqual(findBlockedIpInOutput('Resolving 2606:4700:4700::1111...'), null);
  assert.strictEqual(findBlockedIpInOutput('Connecting to example.com (example.com)|::ffff:8.8.8.8|:443...'), null);
});
