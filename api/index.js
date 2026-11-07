/**
 * api/index.js — Vercel serverless entry point.
 *
 * This exports the Express app so Vercel can serve the marketing/SEO pages and
 * the static UI. IMPORTANT: the classic downloader engine (GNU Wget spawn +
 * local filesystem + Socket.IO long-running jobs) CANNOT run inside a Vercel
 * serverless function. For production downloads, run the engine in a separate
 * always-on worker container and point the frontend at it (see
 * VERCEL_DEPLOYMENT.md). This entry point is for the public site and pages.
 */
var app = require('../app');
module.exports = app;
