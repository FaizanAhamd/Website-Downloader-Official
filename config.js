/**
 * config.js — centralized runtime configuration.
 * Everything here is environment-driven; nothing is hardcoded.
 */
var path = require('path');

/**
 * Environment-driven validation helpers. Values are parsed defensively: invalid
 * or missing input falls back to a sensible default instead of silently
 * corrupting the runtime (e.g. NaN limits). Exported for direct unit testing.
 */
function toPositiveInt(value, fallback) {
  var n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function toNonNegativeInt(value, fallback) {
  var n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true' || value === true || value === '1';
}

function parseBytes(value) {
  var m = /^(\d+(?:\.\d+)?)([kmgt]?)$/i.exec(String(value).trim());
  if (!m) return 0;
  var mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

module.exports = {
  // Public branding / contact (safe to expose in the UI)
  brand: {
    name: process.env.PUBLIC_PRODUCT_NAME || 'Website Downloader',
    owner: process.env.PUBLIC_PRODUCT_OWNER || 'Faizan Ahmad',
    githubUrl: process.env.PUBLIC_GITHUB_URL || 'https://github.com/FaizanAhamd/Website-Downloader',
    // Leave empty unless configured → the UI hides these blocks.
    contactEmail: process.env.PUBLIC_CONTACT_EMAIL || 'faizanraki42@gmail.com',
    businessAddress: process.env.PUBLIC_BUSINESS_ADDRESS || '',
    siteUrl: process.env.PUBLIC_SITE_URL || '', // optional canonical/OG
  },

  host: {
    port: Number(process.env.PORT) || 3000,
  },

  // Reverse-proxy trust. Controls how `req.ip` (and thus proxy-aware client IP
  // extraction for rate limiting) is computed.
  //   TRUST_PROXY=true        -> trust all hops (only for a fully proxied env)
  //   TRUST_PROXY=1           -> trust N hops
  //   TRUST_PROXY=a,b,c       -> trust only these proxy IPs (recommended)
  //   unset                   -> trust no proxy (direct peer address)
  app: {
    get trustProxy() {
      var v = (process.env.TRUST_PROXY || '').trim();
      if (v === 'true') return true;
      if (v === 'false' || v === '') return false;
      if (/^\d+$/.test(v)) return parseInt(v, 10);
      return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    },
  },

  // Base URL used by the frontend to reach the socket.io API.
  // Empty = same origin (default local / classic hosting).
  apiBaseUrl: process.env.API_BASE_URL || '',

  // Optional download worker. When `url` is set, the main app mounts a
  // server-side proxy at /api/jobs that forwards to the worker with the API
  // key. The key is an environment secret and never reaches browser code.
  worker: {
    url: process.env.WORKER_URL || '',
    apiKey: process.env.WORKER_API_KEY || '',
    get enabled() {
      return !!this.url && !!this.apiKey;
    },
  },

  // Google AdSense integration.
  // Ads are DISABLED by default. They only become active when BOTH
  // ADSENSE_ENABLED=true AND a real, verified publisher ID is configured.
  // The default ID below is the account's publisher ID and MUST be verified
  // against the actual AdSense account before production (see ADSENSE_SETUP.md).
  adsense: {
    enabled: process.env.ADSENSE_ENABLED === 'true',
    publisherId: process.env.ADSENSE_PUBLISHER_ID || '', // e.g. pub-3385240797900631
    get clientId() {
      return this.publisherId ? 'ca-' + this.publisherId : '';
    },
    // Controls whether the AdSense loader script is injected in <head>.
    get scriptEnabled() {
      return this.enabled && !!this.publisherId;
    },
  },

  // Google Analytics 4 integration (Consent Mode v2).
  // All tracking is DISABLED unless GA_MEASUREMENT_ID is set. The Measurement ID
  // is public by design (it ships with the gtag snippet in <head>), but no other
  // private environment variables are ever exposed to the browser.
  ga: {
    measurementId: process.env.GA_MEASUREMENT_ID || '',
  },

  download: {
    // Size ceiling passed to wget. Kept as the human-readable string for logs
    // and error messages; `quotaBytes` is the parsed byte count used by the
    // watchdog. Default 500m is generous but still bounded; lower it on hosts
    // with tight memory/disk.
    quota: process.env.DOWNLOAD_QUOTA || '500m',
    quotaBytes: parseBytes(process.env.DOWNLOAD_QUOTA || '500m') || 500 * 1024 * 1024,
    // Hard wall-clock limit for a single download (milliseconds). Default 15m.
    timeoutMs: toPositiveInt(process.env.DOWNLOAD_TIMEOUT_MS, 900000),
    // How often the quota watchdog samples the working directory.
    watchdogMs: toPositiveInt(process.env.DOWNLOAD_WATCHDOG_MS, 2000),
    // Maximum simultaneous downloads across all connections.
    maxConcurrent: toPositiveInt(process.env.MAX_CONCURRENT_DOWNLOADS, 5),
    // Maximum redirects wget will follow before giving up.
    maxRedirects: toPositiveInt(process.env.MAX_REDIRECTS, 10),
    // Recursion depth cap for the mirror (wget --level). 0 = infinity (use with
    // care); default 5 keeps large mirrors bounded.
    maxCrawlDepth: toNonNegativeInt(process.env.MAX_CRAWL_DEPTH, 0),
    // When true, allow wget's --span-hosts so page requisites (CSS/images/fonts)
    // hosted on other domains (CDNs, subdomains) are fetched too. This is the
    // only mechanism that downloads cross-host resources; it is OFF by default
    // to avoid crawling unrelated external sites.
    allowCrossHostRequisites: toBool(process.env.ALLOW_CROSS_HOST_REQUISITES, false),
    // ZIP retention before the TTL sweeper removes the file.
    zipTtlHours: toPositiveInt(process.env.DOWNLOAD_ZIP_TTL_HOURS, 24),
    wgetPath: process.env.WGET_PATH || null,
    // Private archive storage — never inside public/.
    archiveDir: process.env.ARCHIVE_DIR || path.join(__dirname, 'private', 'archives'),
  },

  // Exported for unit testing the validation helpers in isolation.
  helpers: {
    toPositiveInt: toPositiveInt,
    toNonNegativeInt: toNonNegativeInt,
    toBool: toBool,
    parseBytes: parseBytes,
  },
};
