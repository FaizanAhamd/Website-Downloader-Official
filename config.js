/**
 * config.js — centralized runtime configuration.
 * Everything here is environment-driven; nothing is hardcoded.
 */
var path = require('path');

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

  download: {
    quota: process.env.DOWNLOAD_QUOTA || '100m',
    timeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS) || 5 * 60 * 1000,
    watchdogMs: Number(process.env.DOWNLOAD_WATCHDOG_MS) || 2000,
    maxConcurrent: Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 5,
    zipTtlHours: Number(process.env.DOWNLOAD_ZIP_TTL_HOURS) || 24,
    wgetPath: process.env.WGET_PATH || null,
    // Private archive storage — never inside public/.
    archiveDir: process.env.ARCHIVE_DIR || path.join(__dirname, 'private', 'archives'),
  },
};
