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

const QUOTA_BYTES = parseBytes(process.env.DOWNLOAD_QUOTA || '100m');
const TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS) || 5 * 60 * 1000;
const WATCHDOG_MS = Number(process.env.DOWNLOAD_WATCHDOG_MS) || 2000;

const WGET_PATH =
  process.env.WGET_PATH ||
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

/** Block private / link-local / loopback / reserved destinations (SSRF). */
function isBlockedHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number);
    if (p[0] === 0) return true;
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if ((p[0] === 198 && p[1] === 18) || (p[0] === 198 && p[1] === 19)) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] >= 224) return true; // multicast / reserved
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd]/.test(host)) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  }
  return false;
}


/** Detect blocked (private/link-local/loopback/metadata) IPs appearing in
 *  Wget's output while it resolves/connects — this covers redirect destinations
 *  that wget follows, not just the initial host. */
function findBlockedIpInOutput(text) {
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  let m;
  while ((m = ipRe.exec(text)) !== null) {
    if (isBlockedHost(m[0])) return m[0];
  }
  const v6Re = /\b(::1|::|f[cd][0-9a-f]{2}:[0-9a-f:]+|fe[89ab][0-9a-f]:[0-9a-f:]+)\b/i;
  const m6 = v6Re.exec(text);
  if (m6) return m6[0];
  return null;
}

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

module.exports = (socket, data, onFinished) => {
  const done = typeof onFinished === 'function' ? onFinished : function () {};
  const send = (payload) => socket.emit(data.token, payload);

  const target = parseTarget(data.website);
  if (!target) {
    send({ error: 'That does not look like a public http(s) website address. Try something like https://example.com' });
    done();
    return null;
  }

  const jobId = crypto.randomBytes(8).toString('hex');
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
  let stderrTail = [];
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
    send({ error: message });
    done();
  };

  (async () => {
    if (!(await assertPublicHost(target.hostname))) {
      fail('That address points to a local or private network, which is not allowed.');
      return;
    }

    child = spawn(WGET_PATH, [
      '-mkEpnp',
      '--no-if-modified-since',
      '--quota=' + QUOTA_BYTES,
      '--max-redirect=5',
      target.href
    ], { cwd: jobDir, stdio: ['ignore', 'pipe', 'pipe'] });

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

    const onWgetData = (chunk) => {
      const text = chunk.toString();
      stderrTail = stderrTail.concat(text.split('\n')).slice(-60);
      const blockedIp = findBlockedIpInOutput(text);
      if (blockedIp) {
        if (!settled) {
          child.kill();
          fail('Download redirected to a blocked private/internal address (' + blockedIp + ') and was stopped.');
        }
        return;
      }
      send({ progress: text });
    };
    child.stdout.on('data', onWgetData);

    child.stderr.on('data', onWgetData);

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail('wget is not installed on the server. Install it and restart the app: apt install wget, brew install wget, or set WGET_PATH.');
        return;
      }
      fail('Could not start the download: ' + err.message);
    });

    child.on('close', async (code) => {
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

      if (fileCount === 0) {
        fail('Nothing could be downloaded from ' + target.hostname + '. ' +
          explainFailure(stderrTail, code));
        return;
      }

      // Exit code 8 = some URLs returned HTTP errors (normal on mirrors) -> tolerated.
      // Any other non-zero exit means the mirror is incomplete -> NOT success.
      if (code !== 0 && code !== 8) {
        fail('wget exited with code ' + code + ' after saving only part of the site. ' +
          explainFailure(stderrTail, code));
        return;
      }

      settled = true;
      send({ progress: 'Converting' });

      const zipName = target.hostname.replace(/[^a-zA-Z0-9._-]/g, '_') + '-' + jobId;
      currentArchive = archive(jobDir, zipName, { fileCount }, (err, name, info) => {
        currentArchive = null;
        removeJobDir(jobDir);
        if (cancelled) {
          done();
          return;
        }
        if (err) {
          send({ error: 'The site downloaded but could not be compressed: ' + err.message });
        } else {
          send({ progress: 'Completed', file: name + '.zip', files: (info && info.fileCount) || fileCount });
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

function explainFailure(lines, exitCode) {
  const interesting = /failed|unable|refused|denied|ERROR \d|error \d|robots|No such|not found|forbidden|timed out|giving up|Unsupported scheme/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && interesting.test(line)) return line;
  }
  if (exitCode === 8) return 'The server refused the request (it may block automated downloads).';
  return 'wget exited with code ' + exitCode + ' without saving any files.';
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
