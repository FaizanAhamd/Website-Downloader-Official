/**
 * routes/download-api.js — Vercel-compatible HTTP download API.
 *
 * A bounded, recursive mirror of a small publicly accessible site, restoring the
 * asset-discovery behaviour of the original Wget engine (`wget -mkEpnp`): it
 * downloads the page requisites — HTML, CSS (including `url()` references),
 * JavaScript, images, fonts and nested resources — and preserves the site's
 * directory structure, then streams a ZIP archive directly to the browser.
 *
 * Works inside a Vercel serverless function (Hobby): no child processes, no
 * durable storage, no external services. All data is held in-memory for the
 * duration of one request and released when the request ends.
 *
 * Honest scope: this is a bounded static snapshot subject to Vercel Hobby
 * limits. It does NOT execute JavaScript, render SPAs, or mirror very large
 * sites. Oversized or JavaScript-heavy sites are rejected with a clear error.
 * Redirects are followed manually and every hop (including every discovered
 * resource) is SSRF-validated before it is fetched.
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
var MAX_RESOURCES = parseInt(process.env.DOWNLOAD_HTTP_MAX_RESOURCES, 10) || 60;
var TIMEOUT_MS = parseInt(process.env.DOWNLOAD_HTTP_TIMEOUT_MS, 10) || 8000; // < 10s Hobby ceiling
var OVERALL_MS = parseInt(process.env.DOWNLOAD_HTTP_OVERALL_MS, 10) || 9000;
var MAX_REDIRECTS = 5;
var MAX_ASSET_BYTES = 1 * 1024 * 1024;
var MAX_DEPTH = 3; // 0 = html, 1 = direct assets, 2 = CSS-referenced, etc.
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

async function guardedFetch(url, redirectsLeft, deadline) {
  if (Date.now() > deadline) throw httpError(504, 'The download exceeded the overall time limit.');
  if (!(await assertPublicUrl(url))) {
    throw httpError(400, 'A resource points to a local or private network, which is not allowed.');
  }
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  var res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/css,*/*' },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw httpError(504, 'A download timed out.');
    throw httpError(502, 'Could not reach the site: ' + err.message);
  }
  clearTimeout(timer);

  if (res.status >= 300 && res.status < 400) {
    if (redirectsLeft <= 0) throw httpError(502, 'Too many redirects.');
    var location = res.headers.get('location');
    if (!location) throw httpError(502, 'The site returned a redirect without a target.');
    return guardedFetch(new URL(location, url), redirectsLeft - 1, deadline);
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
    if (total > cap) throw httpError(413, 'A resource is too large to mirror.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/* ---------------- Asset discovery (recursive mirror) ---------------- */

// HTML: collect same-origin http(s) references from href/src attributes and
// from inline `url(...)`/`<style>` blocks (so inline background images are found).
function extractHtmlAssets(html, baseUrl) {
  var out = [];
  var re = /<(?:link|script|img|source|video|audio|iframe|embed|object)\b[^>]*(?:href|src|poster)=["']([^"']+)["'][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var abs = resolveSameOrigin(m[1], baseUrl);
    if (abs) out.push(abs);
  }
  // Inline <style> / style="" url(...) references.
  var cssUrls = extractCssUrls(html, baseUrl);
  for (var i = 0; i < cssUrls.length; i++) {
    if (out.indexOf(cssUrls[i]) === -1) out.push(cssUrls[i]);
  }
  return out;
}

// CSS/HTML text: collect `url(...)` references (quoted or not), skipping data: URIs.
function extractCssUrls(text, baseUrl) {
  var out = [];
  var re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    var value = m[2].trim();
    if (/^data:/i.test(value)) continue;
    var abs = resolveSameOrigin(value, baseUrl);
    if (abs) out.push(abs);
  }
  return out;
}

function resolveSameOrigin(ref, baseUrl) {
  try {
    var base = (typeof baseUrl === 'string') ? new URL(baseUrl) : baseUrl;
    var abs = new URL(ref, base);
    if ((abs.protocol === 'http:' || abs.protocol === 'https:') && abs.hostname === base.hostname) {
      return abs.href;
    }
  } catch (err) { /* malformed */ }
  return null;
}

var EXT_BY_TYPE = {
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/x-javascript': '.js',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'application/font-woff': '.woff',
  'font/ttf': '.ttf',
  'application/json': '.json',
  'text/plain': '.txt',
};

// Preserve relative directory structure mirror host/, e.g. /css/site.css ->
// <host>/css/site.css. Root maps to <host>/index.html.
function resourceName(host, urlStr, contentType) {
  var u = new URL(urlStr);
  var path = u.pathname.split('?')[0];
  var segs = path.split('/').filter(Boolean);
  if (!segs.length || path.charAt(path.length - 1) === '/') segs.push('index.html');
  var last = segs[segs.length - 1];
  if (!/\.[A-Za-z0-9]{1,6}$/.test(last)) {
    var ext = EXT_BY_TYPE[contentType] || '';
    segs[segs.length - 1] = last + ext;
  }
  var clean = segs.map(function (seg) {
    return seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  });
  return [host].concat(clean).join('/');
}

/* ---------------- Bounded recursive crawl ---------------- */

async function crawlSite(target) {
  var seen = Object.create(null);
  var files = [];
  var totalBytes = 0;
  var deadline = Date.now() + OVERALL_MS;

  function addFile(name, data) {
    if (totalBytes + data.length > MAX_BYTES) return false;
    totalBytes += data.length;
    files.push({ name: name, data: data });
    return true;
  }

  var queue = [{ url: target.href, depth: 0 }];
  seen[target.href] = true;

  while (queue.length && files.length < MAX_RESOURCES) {
    var item = queue.shift();
    var res;
    try {
      res = await guardedFetch(new URL(item.url), MAX_REDIRECTS, deadline);
    } catch (err) {
      continue; // skip un-fetchable resource rather than fail the whole mirror
    }
    var buf;
    try {
      buf = await readCapped(res.body, MAX_ASSET_BYTES);
    } catch (err) {
      continue;
    }
    var rawType = (res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    var name = resourceName(target.hostname, item.url, rawType);
    if (!addFile(name, buf)) break; // size cap reached

    if (item.depth >= MAX_DEPTH) continue;

    if (rawType === 'text/html') {
      var htmlLinks = extractHtmlAssets(buf.toString('utf8'), item.url);
      for (var a = 0; a < htmlLinks.length; a++) {
        if (!seen[htmlLinks[a]]) {
          seen[htmlLinks[a]] = true;
          queue.push({ url: htmlLinks[a], depth: item.depth + 1 });
        }
      }
    } else if (rawType === 'text/css') {
      var cssLinks = extractCssUrls(buf.toString('utf8'), item.url);
      for (var b = 0; b < cssLinks.length; b++) {
        if (!seen[cssLinks[b]]) {
          seen[cssLinks[b]] = true;
          queue.push({ url: cssLinks[b], depth: item.depth + 1 });
        }
      }
    }
    // Images/fonts/JS: no further recursion.
  }

  return files;
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

    var files = await crawlSite(target);
    if (!files.length) {
      return res.status(502).json({ error: 'Nothing could be downloaded from that address.' });
    }

    var zipBuf = await buildZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + target.hostname + '-' + Date.now() + '.zip"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(zipBuf);
  } catch (err) {
    var status = err.status || 500;
    res.status(status).json({ error: err.message || 'The download failed.' });
  }
});

// Exported for deterministic unit testing of the mirror algorithm.
module.exports = router;
module.exports._internals = {
  extractHtmlAssets: extractHtmlAssets,
  extractCssUrls: extractCssUrls,
  resourceName: resourceName,
  buildZip: buildZip,
  crawlSite: crawlSite,
};
