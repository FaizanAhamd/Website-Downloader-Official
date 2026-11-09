/**
 * Website Downloader — download engine (hardened).
 * - SSRF guard: private/link-local/loopback hosts blocked, DNS pinned.
 * - spawn() instead of execFile(): no maxBuffer ceiling.
 * - Hard quota watchdog: kills wget when the working dir exceeds the cap.
 * - Asynchronous file counting (event loop blocked nahi).
 * - Non-zero wget exit codes handled explicitly (no false "success").
 * - Cancellation honored during archiving too.
 * - wget path configurable; bundled exe used on Windows.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const archive = require('../archiver');

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');

// Runtime limits are centralized in config.js and validated there; the engine
// must never hardcode them. Read once at load time.
const downloadCfg = require('../config').download;

const QUOTA_BYTES = downloadCfg.quotaBytes;
const TIMEOUT_MS = downloadCfg.timeoutMs;
const WATCHDOG_MS = downloadCfg.watchdogMs;
const MAX_REDIRECTS = downloadCfg.maxRedirects;
const MAX_CRAWL_DEPTH = downloadCfg.maxCrawlDepth;
const ALLOW_CROSS_HOST_REQUISITES = downloadCfg.allowCrossHostRequisites;

const WGET_PATH =
  downloadCfg.wgetPath ||
  (process.platform === 'win32'
    ? path.join(__dirname, '..', 'wget.exe')
    : 'wget');

if (!fs.existsSync(WGET_PATH)) {
  console.error('wget binary not found at ' + WGET_PATH +
    '. Install it (apt install wget / brew install wget) or set WGET_PATH.');
}

function parseBytes(value) {
  const m = /^(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(String(value).trim());
  if (!m) return 100 * 1024 * 1024;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function formatBytes(b) {
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

/** True for private, link-local, loopback, reserved or otherwise non-routable
 *  IPv4 (also covering CGNAT, TEST-NET and the cloud-metadata link-local range). */
function isPrivateIpv4(octets) {
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  if (a === 0) return true;                            // "this network"
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 127) return true;                          // loopback 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true;             // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true;    // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true;    // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark networks
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;  // TEST-NET-3
  if (a >= 224) return true;                           // multicast / broadcast / reserved
  return false;
}

/** Extract an embedded IPv4 dotted-quad from an IPv6 literal (e.g.
 *  "::ffff:192.168.1.1" -> [192,168,1,1]). Returns null when absent. */
function embeddedIpv4(host) {
  const m = /([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** Block private / link-local / loopback / reserved destinations (SSRF).
 *  Handles literal IPv4, IPv6 (loopback, ULA, link-local, multicast) and
 *  IPv4-mapped / IPv4-compatible IPv6 — including long-form spellings. */
function isBlockedHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Plain dotted IPv4.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateIpv4(host.split('.').map(Number));
  }

  // Any IPv6 literal (compressed, full, or with an embedded IPv4 quad).
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true; // loopback
    if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;   // unspecified
    if (/^f[cd]/.test(host)) return true;             // ULA fc00::/7
    if (/^fe[89ab]/.test(host)) return true;          // link-local fe80::/10
    if (/^ff/.test(host)) return true;                // multicast ff00::/8 (ff01/ff02/…)

    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) IPv6.
    const embedded = embeddedIpv4(host);
    if (embedded) return isPrivateIpv4(embedded);
  }
  return false;
}


/** Detect blocked (private/link-local/loopback/metadata) IPs appearing in
 *  Wget's output while it resolves/connects — this covers redirect destinations
 *  that wget follows, not just the initial host. Reuses the authoritative
 *  isBlockedHost matcher (IPv4, IPv6, and IPv4-mapped forms). */
function findBlockedIpInOutput(text) {
  if (typeof text !== 'string') return null;

  // Split into host-like tokens. Wget separates addresses with whitespace and
  // punctuation (| ( ) [ ] " '), so a mapped literal like `::ffff:192.168.1.1`
  // survives as a single full token and validation is exact (no false positives
  // from partial regex matches such as `ffff:8.8.8.8`).
  const parts = text.split(/[\s|()\[\]"']+/);
  for (const raw of parts) {
    const token = raw.replace(/,$/, '').trim();
    if (token && isBlockedHost(token)) return token;
  }

  // Fallback: plain IPv4 dotted-quads that may be glued to other output.
  const v4Re = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  let m;
  while ((m = v4Re.exec(text)) !== null) {
    if (isBlockedHost(m[0])) return m[0];
  }
  return null;
}

/**
 * DNS pinning (defense in depth). We cannot force the `wget` child to connect
 * to the exact addresses validated here — it does its own resolution — so a
 * preliminary lookup alone would leave a DNS-rebinding window. Strategy:
 *
 *  1. Resolve ALL A/AAAA records up-front and reject the job if ANY resolves to
 *     a private/link-local/loopback/metadata address (prevents the common
 *     "public hostname, private backend" rebinding trick).
 *  2. While wget runs, findBlockedIpInOutput() continuously scans wget's own
 *     resolution/connection output and the process is killed the moment a
 *     private address appears — covering redirect destinations and mid-job
 *     re-resolution that the initial check cannot see.
 *
 * This is the DNS pinning equivalent for a shelled-out wget; it does NOT rely
 * on a single check.
 */
async function assertPublicHost(hostname) {
  if (isBlockedHost(hostname)) return false;
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (err) {
    return false;
  }
  for (const r of records) {
    if (isBlockedHost(r.address)) return false;
  }
  return records.length > 0;
}

// Contract: the first argument is an emitter object exposing emit(token, payload)
// (a Socket.IO socket, or the job-store adapter used by socket.js / the worker).
// The engine never touches connection lifecycle — it only emits events and calls
// onFinished() exactly once when the job settles.
module.exports = (emitter, data, onFinished) => {
  const done = typeof onFinished === 'function' ? onFinished : function () {};
  const send = (payload) => emitter.emit(data.token, payload);

  const target = parseTarget(data.website);
  if (!target) {
    send({ error: 'That does not look like a public http(s) website address. Try something like https://example.com' });
    done();
    return null;
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  // Prefer the client token (stable across reconnects) for correlation; fall
  // back to the internal job id when no token is available (e.g. worker mode).
  const jobRef = data && data.token ? data.token : jobId;
  const jobDir = path.join(DOWNLOAD_ROOT, jobId);
  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (err) {
    send({ error: 'Could not create a working directory on the server: ' + err.message });
    done();
    return null;
  }

  let settled = false;
  let cancelled = false;
  let timedOut = false;
  let quotaExceeded = false;
  // Keep stdout and stderr SEPARATELY (last 100 lines each) so real network
  // errors on stderr are never lost among stdout progress noise, and so the
  // final diagnostic log shows exactly what wget reported on each stream.
  const TAIL_MAX = 100;
  let stdoutTail = [];
  let stderrTail = [];
  const keepTail = (buf, text) => {
    buf.push(...text.split('\n'));
    if (buf.length > TAIL_MAX) buf.splice(0, buf.length - TAIL_MAX);
    return buf;
  };
  let child = null;
  let currentArchive = null;
  let timer = null;
  let watchdog = null;

  const fail = (message) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (watchdog) clearInterval(watchdog);
    removeJobDir(jobDir);
    console.error('[job ' + jobRef + '] failed: ' + message);
    send({ error: message });
    done();
  };

  (async () => {
    if (!(await assertPublicHost(target.hostname))) {
      fail('That address points to a local or private network, which is not allowed.');
      return;
    }

    // Build the Wget invocation. -mkEpnp = mirror + convert-links + adjust-
    // extension + page-requisites + no-parent. Depth and redirect caps come from
    // validated config; --span-hosts is only enabled by the operator (for CDN
    // / cross-host requisites), never by default.
    const args = [
    '-mkEpnp',

    // Keep Linux production ZIP filenames Windows-compatible.
    '--restrict-file-names=windows',

    '--no-if-modified-since',
    '--quota=' + QUOTA_BYTES,
    '--max-redirect=' + MAX_REDIRECTS
   ];
    if (MAX_CRAWL_DEPTH > 0) args.push('--level=' + MAX_CRAWL_DEPTH);
    if (ALLOW_CROSS_HOST_REQUISITES) args.push('--span-hosts');
    args.push(target.href);

    child = spawn(WGET_PATH, args, { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('[job ' + jobRef + '] started target=' + target.href);


    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);

    // Hard quota watchdog — kills wget as soon as the working dir exceeds the cap.
    watchdog = setInterval(async () => {
      try {
        const size = await sizeOfDir(jobDir);
        if (size > QUOTA_BYTES) {
          quotaExceeded = true;
          child.kill();
        }
      } catch (err) { /* ignore */ }
    }, WATCHDOG_MS);

    // stdout: wget's progress (mirror/link conversion). Streamed live to the
    // client as progress and kept for the diagnostic tail.
    const onStdout = (chunk) => {
      const text = chunk.toString();
      stdoutTail = keepTail(stdoutTail, text);
      send({ progress: text });
    };

    // stderr: wget's diagnostics — the authoritative place for DNS errors,
    // connection failures, resets, TLS problems and redirect destinations.
    // Scan for blocked IPs (SSRF guard) and keep the tail for final logging.
    const onStderr = (chunk) => {
      const text = chunk.toString();
      stderrTail = keepTail(stderrTail, text);
      const blockedIp = findBlockedIpInOutput(text);
      if (blockedIp && !settled) {
        child.kill();
        fail('Download redirected to a blocked private/internal address (' + blockedIp + ') and was stopped.');
      }
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail('wget is not installed on the server. Install it and restart the app: apt install wget, brew install wget, or set WGET_PATH.');
        return;
      }
      fail('Could not start the download: ' + err.message);
    });

    child.on('close', async (code, signal) => {
      // Structured diagnostic log: exit code, signal, and the SEPARATE stdout /
      // stderr tails. This is the primary tool for diagnosing network failures
      // (DNS, connect, reset, TLS, redirects) that wget reports on stderr.
      console.log('[job ' + jobRef + '] WGET EXIT CODE: ' + code);
      console.log('[job ' + jobRef + '] WGET SIGNAL: ' + (signal || 'none'));
      console.log('[job ' + jobRef + '] WGET STDOUT (tail ' + stdoutTail.length + ' lines):\n' + stdoutTail.join('\n'));
      console.log('[job ' + jobRef + '] WGET STDERR (tail ' + stderrTail.length + ' lines):\n' + stderrTail.join('\n'));

      if (settled) return;
      clearTimeout(timer);
      clearInterval(watchdog);

      if (cancelled) {
        settled = true;
        removeJobDir(jobDir);
        done();
        return;
      }
      if (timedOut) {
        fail('The download took longer than ' + Math.round(TIMEOUT_MS / 1000) +
          ' seconds and was stopped. Try a smaller site or a specific page.');
        return;
      }
      if (quotaExceeded) {
        fail('The download exceeded the ' + formatBytes(QUOTA_BYTES) +
          ' quota and was stopped. Try a smaller site or raise DOWNLOAD_QUOTA.');
        return;
      }

      const fileCount = await countFiles(jobDir);
      const dirSize = await sizeOfDir(jobDir).catch(() => 0);
      console.log('[job ' + jobRef + '] DOWNLOADED FILE COUNT: ' + fileCount);
      console.log('[job ' + jobRef + '] DOWNLOAD DIRECTORY SIZE: ' + formatBytes(dirSize));

      if (fileCount === 0) {
        fail('Nothing could be downloaded from ' + target.hostname + '. ' +
          explainFailure(stdoutTail, stderrTail, code));
        return;
      }

      // Exit code 8 = some URLs returned HTTP errors (normal on mirrors) -> tolerated.
      // Any other non-zero exit means the mirror is incomplete -> NOT success.
      if (code !== 0 && code !== 8) {
        fail('wget exited with code ' + code + ' after saving only part of the site. ' +
          explainFailure(stdoutTail, stderrTail, code));
        return;
      }

      settled = true;
      send({ progress: 'Converting' });

      const zipName = target.hostname.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + jobId;
      currentArchive = archive(jobDir, zipName, { fileCount }, (err, name, info) => {
        currentArchive = null;
        removeJobDir(jobDir);
        if (cancelled) {
          console.log('[job ' + jobRef + '] cancelled during archive finalization');
          done();
          return;
        }
        if (err) {
          console.error('[job ' + jobRef + '] archive error: ' + err.message);
          send({ error: 'The site downloaded but could not be compressed: ' + err.message });
        } else {
          const zipFile = name + '.zip';
          const files = (info && info.fileCount) || fileCount;
          const dlUrl = '/download/' + encodeURIComponent(zipFile);
          console.log('[job ' + jobRef + '] archive ready file=' + zipFile +
            ' files=' + files + ' url=' + dlUrl);
          // Include an explicit download URL so both the classic UI and the job
          // store can present a valid, ready-to-use link.
          send({ progress: 'Completed', file: zipFile, files: files, url: dlUrl });
        }
        done();
      });
    });
  })();

  return {
    cancel: function () {
      cancelled = true;
      if (child) child.kill();
      if (currentArchive) currentArchive.abort();
    }
  };
};

/** Accepts what the user typed and returns a URL only if it is a real http(s) address. */
function parseTarget(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'http://' + raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

/**
 * Diagnose a Wget failure from its SEPARATE stdout and stderr tails.
 *
 * The text is drawn from both streams; stderr is the authoritative source for
 * network-level diagnostics (DNS, connect, reset, TLS, redirects). The fallback
 * never claims "without saving any files" — that decision is made by the caller
 * from the real file count, not guessed here.
 */
function explainFailure(stdout, stderr, exitCode) {
  const combine = (arr) => (Array.isArray(arr) ? arr.join('\n') : String(arr || ''));
  const text = (combine(stdout) + '\n' + combine(stderr)).toLowerCase();

  // DNS resolution failures.
  if (/could not resolve|cannot resolve|failed to resolve|unable to resolve host|name or service not known|nxdomain|temporary failure in name resolution|not known/i.test(text)) {
    return 'The domain could not be resolved (DNS failure). Check the address and try again.';
  }
  // TLS / certificate failures.
  if (/unable to verify|self.signed|certificate|ssl|tls|alternative name|hostname mismatch|handshake failure|wrong version number/i.test(text)) {
    return 'The site has an SSL/TLS certificate or handshake problem (expired, self-signed, or hostname mismatch).';
  }
  // Connection refused.
  if (/connection refused|connect failed|failed to connect|network is unreachable|no route to host/i.test(text)) {
    return 'The server refused the connection (connection refused). It may be down or blocking automated downloads.';
  }
  // Connection reset / broken pipe / remote closed.
  if (/connection reset|reset by peer|broken pipe|remote.*closed|connection aborted|econnreset|epipe/i.test(text)) {
    return 'The connection was reset by the remote server while downloading resources.';
  }
  // IPv6-related failures.
  if (/ipv6|address family|trying .*::|network.*unreachable/i.test(text)) {
    return 'There was a network (IPv4/IPv6) connectivity failure while contacting the server.';
  }
  // HTTP 403 (bot blocking).
  if (/403|forbidden|not permitted|response 403/i.test(text)) {
    return 'The server returned HTTP 403 Forbidden — it is blocking automated downloads.';
  }
  // HTTP 404.
  if (/404|not found|error 404/i.test(text)) {
    return 'The server returned HTTP 404 Not Found for the requested page.';
  }
  // robots.txt.
  if (/robots|disallow/i.test(text)) {
    return 'The site\'s robots.txt prevents this path from being downloaded.';
  }
  // Timeout / giving up.
  if (/timed out|giving up|timeout|read timed out/i.test(text)) {
    return 'The download timed out or gave up while fetching resources.';
  }
  if (exitCode === 8) return 'The server refused some requests (it may block automated downloads).';
  return 'The download did not complete successfully (network error, exit code ' + String(exitCode) + ').';
}

/** Asynchronous count — no event-loop blocking. */
async function countFiles(directory) {
  let total = 0;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await countFiles(p);
    else total++;
  }
  return total;
}

async function sizeOfDir(directory) {
  let total = 0;
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const p = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await sizeOfDir(p);
    else total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function removeJobDir(directory) {
  const resolved = path.resolve(directory);
  const root = path.resolve(DOWNLOAD_ROOT);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    console.error('Refusing to delete a path outside the downloads folder: ' + resolved);
    return;
  }
  fs.rm(resolved, { recursive: true, force: true }, (err) => {
    if (err) console.error('Could not clean up ' + resolved + ': ' + err.message);
  });
}

// Re-export helpers for reuse (e.g. the worker validates synchronously).
module.exports.isBlockedHost = isBlockedHost;
module.exports.findBlockedIpInOutput = findBlockedIpInOutput;
module.exports.parseTarget = parseTarget;
module.exports.explainFailure = explainFailure;
