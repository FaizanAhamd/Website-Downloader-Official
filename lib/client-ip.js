/**
 * lib/client-ip.js — safe client-IP extraction.
 *
 * Returns the real client IP when the app runs behind a trusted reverse proxy
 * (req.ip honors Express's `trust proxy` setting and decodes X-Forwarded-For
 * only from trusted hops). When no proxy is trusted, it falls back to the
 * direct socket peer address — never to a client-controlled header.
 */
'use strict';

module.exports = function clientIp(req) {
  if (req && req.ip) return req.ip;
  return (req && req.socket && req.socket.remoteAddress) || '0.0.0.0';
};
