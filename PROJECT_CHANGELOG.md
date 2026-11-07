# Project Changelog

All notable changes to Website Downloader are documented here.

## [0.3.0] — Production-readiness update

### Added
- New public pages: Features, How It Works, Guides landing + 4 original educational guides, FAQ, About, Contact (with form handler), custom 404.
- Expanded header navigation and footer across all pages.
- SEO metadata on every public page: description, author, robots, Open Graph, Twitter Card, canonical URL (when `PUBLIC_SITE_URL` set).
- `robots.txt` and `sitemap.xml` generated from site configuration.
- `ads.txt` generation (returns placeholder until AdSense is enabled & verified).
- Reusable, environment-gated AdSense ad-unit partial and head-script injection.
- Privacy Policy and Terms of Service updated with advertising, cookie, personalised-advertising and opt-out disclosures.
- `vercel.json` + `api/index.js` so the marketing pages can deploy to Vercel.
- Environment variable documentation (`ENVIRONMENT_VARIABLES.md`), AdSense setup guide (`ADSENSE_SETUP.md`), deployment guide (`VERCEL_DEPLOYMENT.md`) and this changelog.
- `dotenv` loading in `bin/www` so `.env` works locally.
- Contact form handling (POST `/contact`) with validation and a confirmation state.

### Changed
- `config.js` now includes an `adsense` block and a default contact email.
- Header footer links now point to real pages instead of in-page anchors.
- License file updated to preserve the original author attribution alongside the current maintainer.

### Security
- Existing protections retained: SSRF guard, private/localhost/IPv4/IPv6 blocking, DNS pinning, redirect checks, cloud metadata blocking, download quota, timeout, watchdog, concurrent-job limits, ZIP path-traversal checks, secure private storage.

### Fixed
- Frontend download request now sends the `website` field (server expects `data.website`); previously jobs silently never started.
- ZIP download route deletes the archive even on failed/interrupted transfers (best-effort).
- Archive directory is guaranteed to exist at boot for fresh clones.

### Notes
- Ads remain disabled by default and must be verified with Google before enabling.
- The long-running downloader engine cannot run inside a Vercel serverless function; it requires an always-on worker (see `VERCEL_DEPLOYMENT.md`).

## [0.3.1] — Guide alignment, SEO correctness, final packaging

### Changed
- Guides revised to the four requested titles: *How to Download a Website for Offline Browsing*, *What Is Website Mirroring?*, *Why Offline Copies Look Different*, *Website Download Troubleshooting*.
- `sitemap.xml` and `robots.txt` now derive the base URL from the configured `PUBLIC_SITE_URL`, falling back to the real request host — placeholder URLs are never emitted.
- Switched `ads.txt` to a static `public/ads.txt` placeholder (single source of truth); removed the duplicate dynamic route.

### Added
- `PROJECT_AUDIT.md` — architecture, functionality, bugs, security, SEO, AdSense and Vercel analysis.
- `TEST_REPORT.md` — actual executed test results with pass/not-tested status.
- `website-downloader-final.zip` — packaging artifact excluding `node_modules`, `.git`, runtime archives, downloads and secrets.

## [0.4.0] — Deployable worker, safe SEO, rate limiting, dependency hardening

### Added
- **`worker/server.js`** — deployable, always-on HTTP worker that reuses the Wget/archiver
  engine (`POST /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`,
  `GET /api/jobs/:id/download`, `/healthz`). Verified end-to-end via polling.
- **Worker polling mode** in the frontend: when `API_BASE_URL` is set, the UI creates,
  polls and downloads from the worker; otherwise it uses the classic Socket.IO mode.
- **CORS** reflection and a fixed-window rate limiter on worker job creation.
- **Rate limiter** on the contact form.

### Changed
- Primarysitemap.xml`** returns 404 and **`robots.txt`** omits the Sitemap line when
  `PUBLIC_SITE_URL` is unset — host headers are never trusted and no placeholder URLs are
  published (canonical/OG likewise only when a domain is configured).
- **Dependency hardening:** upgraded `hbs@4.4.0` and pinned `handlebars@4.7.10` via
  `overrides`, resolving 2 critical `handlebars` advisories.
- Contact form note is explicit that it validates and directs to email; it does not emit
  messages by itself (no email delivery service is connected).

### Verified
- Socket.IO local mode: submit → live progress → Completed → ZIP download (200) → delete-on-download.
- Worker polling mode: create → poll → Completed → worker ZIP download (200) → delete-on-download.
- All public routes 200; unknown routes 404; `sitemap.xml` 404 without a configured domain.

## [0.5.0] — Security audit round (worker auth, SSRF redirect guard, tests)

### Security (worker)
- **API-key authentication** on every `/api/jobs*` endpoint (`WORKER_API_KEY`, bearer). Without a configured key the API refuses (503). The key is an environment secret and never reaches browser code.
- **Strict CORS allowlisting** (`WORKER_CORS_ORIGIN`); disallowed origins get no ACAO header and preflights are rejected (403). No arbitrary origins.
- **Server-side worker proxy** in the main app (`routes/worker-proxy.js`): public users call their own origin `/api/jobs…` and the app forwards with the bearer key. Browser never sees the key. Mounted only when `WORKER_URL` is configured.
- **Synchronous SSRF validation** in the worker: input must be http(s) and the hostname must not be a blocked/private/link-local address (reuses engine `parseTarget`/`isBlockedHost`).
- **Runtime redirect guard** in `wget/index.js`: Wget output is scanned for connections/resolutions to blocked IPs (IPv4 + IPv6) and any such redirect aborts the download. `--max-redirect=5` also bounds redirect chains.

### Hardening
- Shared memory-bounded rate limiter (`lib/rate-limit.js`): periodic expiry + hard entry cap; used for both contact form and worker job creation. Keyed on `req.socket.remoteAddress` only (X-Forwarded-For never trusted).
- Request body parsing: `express.urlencoded({ extended: true })` + JSON, both size-bounded (32kb); oversized bodies rejected with 413.
- Archive-upload error handling: when `ARCHIVE_UPLOAD_URL` is set, a job is only marked completed after a successful 2xx upload; on failure the job is marked failed with a meaningful error and the temp archive is cleaned up.

### Engineering
- Automated tests added (`npm test` / `node --test`), 22 passing: public routes, contact GET/POST (valid/missing/oversized), worker auth, CORS, URL scheme + SSRF helpers, job lifecycle (create/poll/download/delete), cancellation, and rate-limit burst.
