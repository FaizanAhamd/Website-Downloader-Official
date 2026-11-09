/**
 * Wget diagnostics unit tests (node --test).
 *
 * Verifies that explainFailure correctly distinguishes the main network failure
 * classes from the SEPARATE stdout/stderr tails, and that it never reports
 * "without saving any files" (that decision lives with the caller, based on the
 * real file count).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { explainFailure } = require('../wget');

test('explainFailure: DNS failure is detected', () => {
  const msg = explainFailure([], [
    'Resolving foo.invalid (foo.invalid)... failed: Name or service not known.',
    'failed to resolve host foo.invalid',
  ], 4);
  assert.match(msg, /DNS failure/i);
});

test('explainFailure: TLS/certificate failure is detected', () => {
  const msg = explainFailure([], [
    'ERROR: cannot verify www.example.com\'s certificate, issued by',
    'Unable to locally verify the issuer\'s authority.',
  ], 5);
  assert.match(msg, /SSL\/TLS/i);
});

test('explainFailure: connection refused is detected', () => {
  const msg = explainFailure([], [
    'Connecting to example.com|93.184.216.34|:443... failed: Connection refused.',
  ], 4);
  assert.match(msg, /connection refused/i);
});

test('explainFailure: connection reset is detected', () => {
  const msg = explainFailure([], [
    'Read error (Connection reset by peer) in headers.',
  ], 4);
  assert.match(msg, /reset/i);
});

test('explainFailure: HTTP 403 is detected', () => {
  const msg = explainFailure([], ['The server returned 403 Forbidden.'], 8);
  assert.match(msg, /403/i);
});

test('explainFailure: HTTP 404 is detected', () => {
  const msg = explainFailure([], ['2024-01-01 ERROR 404: Not Found.'], 8);
  assert.match(msg, /404/i);
});

test('explainFailure: timeout is detected', () => {
  const msg = explainFailure([], ['Read timed out.'], 4);
  assert.match(msg, /timed out/i);
});

test('explainFailure: exit code 8 maps to server-refusal message', () => {
  const msg = explainFailure([], ['Server returned error.'], 8);
  assert.match(msg, /refused some requests/i);
});

test('explainFailure: never claims "without saving any files"', () => {
  const msg = explainFailure(['Converting links in 190 files in 1.4 seconds.'], [], 4);
  assert.ok(!/without saving any files/i.test(msg), 'must not say "without saving any files"');
  assert.match(msg, /did not complete successfully|network error/i);
});

test('explainFailure: uses stderr over stdout for diagnostic text', () => {
  // stdout is only progress; stderr holds the real error.
  const msg = explainFailure(
    ['Converting links in 190 files in 1.4 seconds.'],
    ['failed to resolve host down.invalid'],
    4
  );
  assert.match(msg, /DNS failure/i);
});
