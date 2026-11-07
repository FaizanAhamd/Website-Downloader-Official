# Project Audit — Website Downloader

Audit date: latest production-readiness revision
Audited source: the actual working tree (confirmed present: `app.js`, `bin/www`, `config.js`, `routes/index.js`, `wget/index.js`, `archiver/index.js`, `socket/socket.js`, `views/*`, `public/*`).

---

## 1. Existing architecture

- **Runtime:** Node.js ≥ 18, `Express 4` with `hbs` (Handlebars) server-side rendering.
- **Realtime:** `Socket.IO 4` — the browser connects and emits a `request` carrying a client-generated token + the website URL; the server emits progress on that token channel.
- **Download engine:** `wget/index.js` spawns GNU Wget (bundled `wget.exe` on Windows or `WGET_PATH`). It enforces SSRF guard, DNS pinning, quota/timeout watchdog, async file counting, and explicit exit-code handling.
- **ZIP generation:** `archiver/index.js` zips the working directory into the private archive dir; supports cancellation via `abort()`; sweeps old ZIPs by TTL.
- **Serving:** `bin/www` creates the HTTP server, wires Socket.IO, handles graceful shutdown. `routes/index.js` serves public pages, the ZIP download route (with path-traversal guard and delete-on-download), and SEO files.
- **Config:** `config.js` is fully environment-driven.

## 2. Important files

| File | Purpose |
|---|---|
| `bin/www` | HTTP + Socket.IO bootstrap; loads `.env` via dotenv. |
| `app.js` | Express app, middleware, view/partials registration, error handlers. |
| `config.js` | Centralized environment configuration (brand, adsense, download engine). |
| `routes/index.js` | Public pages + `/download/:file` + robots/sitemap. |
| `wget/index.js` | Hardened Wget engine (SSRF, quotas, timeout, async count). |
| `archiver/index.js` | ZIP creation, TTL sweep, cancellation-aware. |
| `socket/socket.js` | Concurrency limits, job lifecycle, cancel handler. |
| `data/guides.js` | Four original educational guides. |
| `views/*` | hbs templates (layout, index, about, features, how-it-works, guides, guide, faq, contact, privacy, terms, 404, partials/ad-unit). |
| `public/stylesheets/{style,pages}.css` | Design system + inner-page styles. |
| `public/js/downloader.js` | Frontend logic (state machine, Socket.IO client). |
| `vercel.json`, `api/index.js` | Vercel config + serverless entry. |

## 3. Existing functionality (verified)

- URL input + client/server validation (http(s) only).
- Wget mirroring with live log stream and running file count.
- Indeterminate progress (no fake percentages).
- Download cancellation (UI + server).
- ZIP generation with real filename + absolute file count reported on completion.
- ZIP download via `/download/:file`, delete-on-download.
- TTL sweep of stale archives.
- Private archive storage (never under `public/`).

## 4. Current bugs / issues found & fixed

1. **Frontend request lacked `website` field.** The server reads `parseTarget(data.website)`; the frontend only sent `{ token }`, so jobs silently never started. **Fixed:** emit `{ token, website }`.
2. **Partial not registered → 500 on every page using `{{> ad-unit}}`.** `hbs.registerPartials` is asynchronous and renames to `ad_unit`. **Fixed:** synchronous registration with explicit `ad-unit` name in `app.js`.
3. **Frontend crashed on non-home pages.** `input.addEventListener`/`connStatus` ran on pages without the downloader. **Fixed:** guards + only connect when the downloader form exists.
4. **ZIP left on failed/interrupted transfer.** **Fixed:** `/download/:file` now deletes best-effort on both success and failure (ignores ENOENT).
5. **Fresh clone could hit ENOENT on archive dir.** **Fixed:** guaranteed `mkdirSync` at boot in `routes/index.js` (and archiver already ensures it).
6. **`.env` not loaded.** `dotenv` was a dependency but never invoked. **Fixed:** loaded at top of `bin/www`.

## 5. Security posture

Present and active:

- SSRF guard (private/link-local/loopback blocked), hostname resolved and validated, IP pinned before outbound request.
- Redirect destination validation; cloud metadata endpoint blocking (e.g. `169.254.169.254`).
- Download quota (`DOWNLOAD_QUOTA`), timeout (`DOWNLOAD_TIMEOUT_MS`), watchdog (`DOWNLOAD_WATCHDOG_MS`), concurrent-job cap (`MAX_CONCURRENT_DOWNLOADS`).
- ZIP path-traversal protection on `/download/:file` (regex + prefix check).
- Private archive storage; archives not exposed as public static assets.
- Input sanitization on URL; JSON/urlencoded body limits on `/contact`.
- No secrets committed; `.env` gitignored; `.env.example` holds only safe defaults.

Notes: rate limiting is implemented via a shared, memory-bounded limiter (contact form and worker job creation), keyed on the socket peer address only. `npm audit`: 2 critical `handlebars` advisories resolved via `hbs@4.4.0` + `handlebars@4.7.10` override; one moderate remains in `hbs` itself (GHSA-7f5c-rpf4-86p8, no fix) — mitigated by running in production mode with first-party templates only (user input never reaches the template compiler, template/partial directories are never exposed).

Worker API security (implemented): bearer API-key auth on all `/api/jobs*` endpoints; strict CORS allowlist; server-side proxy so the key never reaches browsers; synchronous http(s)+blocked-host validation; runtime redirect SSRF guard in the engine.

## 6. SEO status

- Unique per-page titles and meta descriptions (title variable set per route; meta description in layout).
- Open Graph + Twitter Card; canonical only when `PUBLIC_SITE_URL` is configured (so no placeholder URL is published).
- Semantic HTML, heading hierarchy, internal nav and footer links.
- `robots.txt` generated from config (does not block Google/AdSense crawlers).
- `sitemap.xml` generated from `PUBLIC_SITE_URL` — **it intentionally does not emit placeholder URLs** when no domain is set.
- Custom 404 page.
- Structured data: not yet added (only add where accurate).

## 7. AdSense readiness

- Fully gated by env: loader script injected only when `ADSENSE_ENABLED=true` **and** a publisher ID is set.
- Reusable `views/partials/ad-unit.hbs`; used only on content pages (About, Guides, Features, Contact, Privacy, Terms). **Never** placed near downloader controls.
- Privacy policy includes advertising, cookie, personalised-advertising and opt-out disclosures.
- `ads.txt` static placeholder file; publisher line only after verification.
- Publisher ID `pub-3385240797900631` is unverified and treated as config the owner must confirm in the AdSense account.
- Ad-unit slot IDs in `ad-unit.hbs` are placeholders (never rendered while disabled) and must be replaced with real slots before enabling.
- Consent management (e.g. EEA cookie consent) is not yet implemented; required before serving ads to affected regions.
- Google site verification is not started; no verification code/record is invented. The live domain must be submitted by the owner.

## 8. Vercel deployment blockers & architecture

**Blocker:** the download engine spawns Wget and uses a local filesystem + Socket.IO long-running jobs. These cannot run reliably inside a Vercel serverless function (no Wget binary, no durable local FS, function time limits, websocket edge caveats).

**Architecture (implemented in this codebase):**

1. Vercel serves the frontend + marketing/SEO pages (the included `vercel.json` + `api/index.js` support this).
2. **`worker/server.js`** — a deployable, always-on worker that reuses the Wget/archiver engine and exposes an HTTP **polling API** (`POST /api/jobs`, `GET /api/jobs/:id`, cancel, download, `/healthz`) with CORS, rate limiting and concurrency caps.
3. The Vercel frontend runs in **worker polling mode** when `API_BASE_URL` is set; no long-lived socket is needed on the edge.
4. **Persistent object storage** for ZIP archives is supported via the optional `ARCHIVE_UPLOAD_URL` hook on the worker (disabled by default).
5. Set `PUBLIC_SITE_URL` to the real Vercel domain for canonical/sitemap. When it is unset, `sitemap.xml` returns 404 and `robots.txt` omits the Sitemap line — no placeholder or host-derived URLs are published.

**Costs/limits:** Vercel Hobby is free (limits on build minutes and Function execution time). The worker needs a small always-on host (free-tier options exist but generally require a persistent process); object storage free tiers have size limits. No paid infrastructure is introduced without approval. Local Express dev remains fully supported (classic Socket.IO mode is the default).

**Status:** configuration is ready; deployment is **not** performed (needs owner Vercel account/domain + worker hosting). The Socket.IO client script is only loaded in classic mode so no 404 occurs on Vercel. Set `PUBLIC_SITE_URL`, `WORKER_URL`, `WORKER_API_KEY`, and `TRUST_PROXY` on Vercel before the downloader works in production.

## 9. Recommended architecture (summary)

Keep the current Express + Handlebars + Socket.IO app for local dev and for the marketing/SEO pages. For production downloads on Vercel, split: Vercel = static UI + pages; worker = Wget/archiver; object storage = ZIPs; polling = progress. This preserves all existing downloader features while being deployment-compatible.
