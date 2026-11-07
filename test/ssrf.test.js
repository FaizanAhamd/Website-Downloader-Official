/**
 * SSRF guard unit tests (node --test).
 * Verifies the blocked-host matcher and the runtime output parser used to stop
 * Wget if a redirect/connection resolves to a private/internal address.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isBlockedHost, findBlockedIpInOutput, parseTarget } = require('../wget');

const blocked = [
  '127.0.0.1', 'localhost', '10.0.0.1', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
  '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1',
];

const allowed = ['8.8.8.8', '1.1.1.1', 'example.com', '93.184.216.34'];

test('isBlockedHost rejects private/link-local/loopback/metadata', () => {
  for (const h of blocked) {
    assert.ok(isBlockedHost(h), 'expected blocked: ' + h);
  }
});

test('isBlockedHost allows public hosts', () => {
  for (const h of allowed) {
    assert.ok(!isBlockedHost(h), 'expected allowed: ' + h);
  }
});

test('parseTarget only accepts http(s)', () => {
  assert.ok(parseTarget('https://example.com'));
  assert.ok(parseTarget('http://example.com'));
  assert.strictEqual(parseTarget('ftp://example.com'), null);
  assert.strictEqual(parseTarget('javascript:alert(1)'), null);
  assert.strictEqual(parseTarget('file:///etc/passwd'), null);
  assert.strictEqual(parseTarget(''), null);
});

test('findBlockedIpInOutput detects private IPs in Wget output', () => {
  const line = 'Connecting to example.com (example.com)|169.254.169.254|:443... connected.';
  assert.strictEqual(findBlockedIpInOutput(line), '169.254.169.254');

  const line2 = 'Resolving internal (internal)... 10.0.0.8\n';
  assert.strictEqual(findBlockedIpInOutput(line2), '10.0.0.8');
});

test('findBlockedIpInOutput ignores normal output', () => {
  assert.strictEqual(findBlockedIpInOutput('200 OK\nLength: 1963 [text/javascript]'), null);
  assert.strictEqual(findBlockedIpInOutput('Resolving example.com (example.com)... 93.184.216.34'), null);
});
