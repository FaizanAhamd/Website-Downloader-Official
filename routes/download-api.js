/**
 * routes/download-api.js — Vercel-compatible HTTP download API.
 *
 * Replaces the Socket.IO/Wget long-running path for production with a single
 * HTTP request that mirrors a small publicly accessible site (HTML + linked
 * same-origin static resources) and streams a ZIP archive back to the browser.
 *
 * Works inside a Vercel serverless function (Hobby): no child processes, no
 * durable storage, no external services. All data stays in-memory for the
 * duration of one request and is released when the request ends.
 *
 * Honest scope: this is a bounded static snapshot. It does NOT execute
 * JavaScript, render SPAs, or mirror very large sites. Oversized or
 * JavaScript-heavy sites are rejected with a clear error. Redirects are
 * followed manually and every hop is SSRF-validated.
 */
'use strict';

var express = require('express');
var dns = require('dns').promises;
var archiver = require('archiver');
var wget = require('../wget');
var createRateLimit = require('../lib/rate-limit');
var clientIp = require('../lib/client-ip');

var router = express.Router();

// Bounds (env-overridable). Kept within Vercel Hobby function limits.
var MAX_BYTES = parseInt(process.env.DOWNLOAD_HTTP_MAX_BYTES, 10) || 4 * 1024 * 1024; // 4 MB total
var MAX_RESOURCES = parseInt(process.env.DOWNLOAD_HTTP_MAX_RESOURCES, 10) || 40;
var TIMEOUT_MS = parseInt(process.env.DOWNLOAD_HTTP_TIMEOUT_MS, 10) || 8000; // < 10s Hobby ceiling
var MAX_REDIRECTS = 5;
var MAX_ASSET_BYTES = 1 * 1024 * 1024;
var CONCURRENCY = 6;
var UA = 'Website-Downloader/1.0 (+https://github.com/FaizanAhamd/Website-Downloader)';

var limit = createRateLimit({ windowMs: 60 * 1000, max: 20, maxEntries: 1000 });

function httpError(status, message) {
  var err = new Error(message);
  err.status = status;
  return err;
}

async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (wget.isBlockedHost(url.hostname)) return false;
  try {
    var records = await dns.lookup(url.hostname, { all: true });
    if (!records.length) return false;
    for (var i = 0; i < records.length; i++) {
      if (wget.isBlockedHost(records[i].address)) return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function guardedFetch(url, redirectsLeft) {
  if (!(await assertPublicUrl(url))) {
    throw httpError(400, 'That address points to a local or private network, which is not allowed.');
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  var res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw httpError(504, 'The download timed out. Try a smaller or faster site.');
    throw httpError(502, 'Could not reach the site: ' + err.message);
  }
  clearTimeout(timer);

  if (res.status >= 300 && res.status < 400) {
    if (redirectsLeft <= 0) throw httpError(502, 'Too many redirects.');
    var location = res.headers.get('location');
    if (!location) throw httpError(502, 'Site returned a redirect without a target.');
    var nextUrl = new URL(location, url);
    return guardedFetch(nextUrl, redirectsLeft - 1);
  }
  if (res.status < 200 || res.status >= 300) {
    throw httpError(502, 'The site responded with HTTP ' + res.status + '.');
  }
  return res;
}

async function readCapped(stream, cap) {
  var chunks = [];
  var total = 0;
  var reader = stream.getReader();
  for (;;) {
    var step = await reader.read();
    if (step.done) break;
    var buf = Buffer.from(step.value);
    total += buf.length;
    if (total > cap) throw httpError(413, 'This website is too large to mirror within the free service limit.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Collect same-origin static asset URLs referenced by the HTML.
function extractAssets(html, baseUrl) {
  var found = [];
  var re = /<(?:link|script|img|source|video|audio|iframe)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      var abs = new URL(m[1], baseUrl);
      if ((abs.protocol === 'http:' || abs.protocol === 'https:') && abs.hostname === baseUrl.hostname) {
        found.push(abs.href);
      }
    } catch (err) { /* ignore malformed */ }
  }
  // Also CSS `url(...)` in inline styles is not handled; keep it simple.
  var unique = [];
  var seen = {};
  for (var i = 0; i < found.length && unique.length < MAX_RESOURCES; i++) {
    if (!seen[found[i]]) {
      seen[found[i]] = true;
      unique.push(found[i]);
    }
  }
  return unique.slice(0, MAX_RESOURCES);
}

function safePath(host, resourceUrl) {
  var p = new URL(resourceUrl).pathname;
  var segments = p.split('/').filter(Boolean);
  if (!segments.length) segments = ['index.html'];
  var clean = segments.map(function (seg) {
    return seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  });
  if (/\.(html?|css|js|json|xml)$/i.test(clean[clean.length - 1]) === false) {
    // keep extension from URL if present
  }
  return [host].concat(clean).join('/');
}

async function fetchAsset(url) {
  var res = await guardedFetch(new URL(url), 3);
  var data = await readCapped(res.body, MAX_ASSET_BYTES);
  return data;
}

function buildZip(files) {
  return new Promise(function (resolve, reject) {
    var archive = archiver('zip', { zlib: { level: 9 } });
    var chunks = [];
    archive.on('data', function (c) { chunks.push(c); });
    archive.on('end', function () { resolve(Buffer.concat(chunks)); });
    archive.on('error', reject);
    files.forEach(function (f) { archive.append(f.data, { name: f.name }); });
    archive.finalize();
  });
}

router.post('/', async function (req, res) {
  try {
    if (limit.check(clientIp(req))) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    var raw = ((req.body && req.body.url) || '').toString().trim();
    var target = wget.parseTarget(raw);
    if (!target) {
      return res.status(400).json({ error: 'That does not look like a public http(s) website address.' });
    }
    if (wget.isBlockedHost(target.hostname)) {
      return res.status(400).json({ error: 'That address points to a local or private network, which is not allowed.' });
    }

    var mainRes = await guardedFetch(target, MAX_REDIRECTS);
    var html = await readCapped(mainRes.body, MAX_BYTES);
    var isHtml = (mainRes.headers.get('content-type') || '').toLowerCase().includes('text/html');

    var files = [{ name: safePath(target.hostname, target.href), data: html }];

    if (isHtml) {
      var assets = extractAssets(html.toString('utf8'), target.href);
      var results = [];
      var index = 0;
      async function worker() {
        while (index < assets.length) {
          var idx = index++;
          try {
            var data = await fetchAsset(assets[idx]);
            results.push({ name: safePath(target.hostname, assets[idx]), data: data });
          } catch (err) {
            // Skip an un-fetchable asset (e.g. blocked, 404, timeout) rather than fail the whole mirror.
          }
        }
      }
      var pool = [];
      for (var i = 0; i < Math.min(CONCURRENCY, assets.length); i++) pool.push(worker());
      await Promise.all(pool);
      // Apply a global total cap across all collected bytes.
      var total = html.length;
      for (var j = 0; j < results.length; j++) {
        total += results[j].data.length;
        if (total > MAX_BYTES) {
          results = results.slice(0, j);
          break;
        }
      }
      files = files.concat(results);
    }

    var zipBuf = await buildZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + target.hostname + '-' + Date.now() + '.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(zipBuf);
  } catch (err) {
    var status = err.status || 500;
    if (status === 413) {
      return res.status(413).json({ error: err.message });
    }
    res.status(status).json({ error: err.message || 'The download failed.' });
  }
});

module.exports = router;
