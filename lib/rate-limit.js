/**
 * lib/rate-limit.js — fixed-window per-key rate limiter with bounded memory.
 *
 * - Entries older than the window are pruned periodically.
 * - The number of stored keys is hard-bounded (oldest evicted first).
 * - The caller supplies the key (must be the true peer address, NOT a client-
 *   controlled header such as X-Forwarded-For).
 */
'use strict';

module.exports = function createRateLimit(options) {
  const opts = options || {};
  const windowMs = opts.windowMs || 60 * 1000;
  const max = opts.max || 10;
  const maxEntries = opts.maxEntries || 1000;

  const map = new Map();

  function prune() {
    const now = Date.now();
    // Remove expired entries.
    for (const [key, rec] of map) {
      if (now - rec.start > windowMs) map.delete(key);
    }
    // Bound total entries (evict oldest when over budget).
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  const interval = setInterval(prune, Math.max(windowMs, 1000)).unref();

  return {
    /** Returns true when the key has exceeded the allowed count in the window. */
    check(key) {
      const now = Date.now();
      let rec = map.get(key);
      if (!rec || now - rec.start > windowMs) {
        rec = { start: now, count: 0 };
        map.set(key, rec);
      }
      rec.count++;
      return rec.count > max;
    },
    size() { return map.size; },
    close() { clearInterval(interval); },
  };
};
