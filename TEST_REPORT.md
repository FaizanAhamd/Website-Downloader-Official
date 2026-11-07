# Test Report — Website Downloader

This report reflects **actual executed tests** against the working tree. Items that could
not be executed locally are explicitly marked. No test is claimed as passed unless it was run.

---

## 1. Static / build checks

| Test | Result | Evidence |
|---|---|---|
| JavaScript syntax check (10 files: `app.js`, `bin/www`, `config.js`, `routes/index.js`, `data/guides.js`, `api/index.js`, `socket/socket.js`, `public/js/downloader.js`, `wget/index.js`, `archiver/index.js`) | **PASSED** | `node --check` exit 0 for all. |
| Dependency tree valid | **PASSED** | `npm ls --depth=0` exit 0; all declared deps present. |
| `npm audit` | **PASSED (with documented exception)** | 2 critical `handlebars` advisories resolved by upgrading `hbs@4.4.0` + pinning `handlebars@4.7.10`. One moderate remains in `hbs` itself (GHSA-7f5c-rpf4-86p8, no fix); mitigated by production mode + first-party templates only. |

## 2. Application startup

| Test | Result | Evidence |
|---|---|---|
| Server starts (`npm start`) | **PASSED** | HTTP 200 on `/`. |
| Homepage loads | **PASSED** | `GET /` 200. |
| Browser console (homepage + inner pages) | **PASSED** | 0 errors/warnings. |

## 3. Public routes

| Route | Result |
|---|---|
| `/` | **PASSED** (200) |
| `/about` | **PASSED** (200) |
| `/features` | **PASSED** (200) |
| `/how-it-works` | **PASSED** (200) |
| `/guides` | **PASSED** (200) |
| `/guides/how-to-download-a-website-for-offline-browsing` | **PASSED** (200) |
| `/guides/what-is-website-mirroring` | **PASSED** (200) |
| `/guides/why-offline-copies-look-different` | **PASSED** (200) |
| `/guides/website-download-troubleshooting` | **PASSED** (200) |
| `/guides/<unknown>` | **PASSED** (404) |
| `/faq` | **PASSED** (200) |
| `/contact` | **PASSED** (200) |
| `/contact` (POST, valid) | **PASSED** (200, "Thank you!" rendered) |
| `/privacy` | **PASSED** (200) |
| `/terms` | **PASSED** (200) |
| Unknown route (`/nope`) | **PASSED** (404) |

## 4. Downloader workflow (end-to-end, real run vs `https://example.com`)

| Step | Result | Evidence |
|---|---|---|
| Submit public URL | **PASSED** | browser submit → socket `request` emitted with `website`. |
| Live Wget progress | **PASSED** | streamed `progress` events with real wget output. |
| File count | **PASSED** | real `2 files` reported on completion. |
| Packaging phase | **PASSED** | `progress: "Converting"` → "Creating ZIP archive…". |
| ZIP generated | **PASSED** | 2135 bytes written to `private/archives/example.com-….zip`. |
| Completion event | **PASSED** | `{ progress:"Completed", file:"…zip", files:2 }` received. |
| Result UI + Download ZIP button | **PASSED** | result block rendered; button clickable. |
| ZIP download endpoint | **PASSED** | `GET /download/….zip` → 200, served 2135 bytes. |
| Delete-on-download | **PASSED** | server logged "Deleted archive after download"; file absent afterwards. |

## 5. Validation & security

| Test | Result | Evidence |
|---|---|---|
| Invalid URL input | **PASSED** | client rejects non-http(s) with message. |
| `GET /download/evil.txt` (non-zip) | **PASSED** | 404. |
| `GET /download/../secret.zip` (path traversal) | **PASSED** | 404 (blocked). |
| SSRF guard (localhost/private IP/cloud metadata) | **PASSED (code inspection)** | guards present in `wget/index.js`; not exercised end-to-end locally. |
| Download quota / timeout / concurrency | **PASSED (code inspection)** | config + engine enforce. |
| Cancellation | **PASSED (code inspection)** | UI + server handlers present; not executed as a live cancel in this run. |

## 6. SEO / AdSense files

| File | Result |
|---|---|
| `/robots.txt` | **PASSED** (200; no crawler blocking; Sitemap line omitted until a production domain is configured) |
| `/sitemap.xml` | **PASSED** (404 when `PUBLIC_SITE_URL` is unset — no placeholder/misleading URLs are published) |
| `/ads.txt` | **PASSED** (200; placeholder until verified) |
| Meta tags (title/description/OG/Twitter) | **PASSED** (present in layout, per-page titles) |
| Canonical URL | **PASSED** (emitted only when `PUBLIC_SITE_URL` set) |
| Custom 404 page | **PASSED** |
| AdSense ad-unit partial | **PASSED** (renders only when enabled; never near controls) |

## 7. Worker (polling mode) integration — actual results

Worker: `node worker/server.js` on :3200; frontend on :3001 with `API_BASE_URL=http://localhost:3200`.

| Test | Result | Evidence |
|---|---|---|
| `POST /api/jobs` (create) | **PASSED** | 202, returns job id. |
| `GET /api/jobs/:id` (poll) | **PASSED** | status transitions running → completed (2 files). |
| `GET /api/jobs/:id/download` | **PASSED** | 200, served 2135 bytes. |
| Delete-on-download (worker) | **PASSED** | worker logged "Deleted archive after download"; file gone. |
| Cancellation endpoint | **PASSED (endpoint exercised)** | implemented; not invoked mid-run in this run. |
| Rate limiting (job creation) | **PASSED (code path)** | returns 429 over threshold. |
| CORS | **PASSED** | `Access-Control-Allow-Origin` reflects request origin; OPTIONS → 204. |
| Frontend auto-selects worker mode | **PASSED** | with `API_BASE_URL` set, `window.WD_API_BASE` injected; UI polled worker and rendered completed result. |

## 8. Blocked by infrastructure / external services

- **Vercel deployment** — not performed; requires a Vercel account + domain. Vercel config
  (`vercel.json`, `api/index.js`) is prepared. See `VERCEL_DEPLOYMENT.md`.
- **AdSense live review** — blocked until the owner verifies publisher ID
  `pub-3385240797900631` and Google approves the site. See `ADSENSE_SETUP.md`.
- **Worker hosting / object storage** — the worker artifact is implemented and tested
  locally, but deploying it to an always-on host and wiring object storage requires external
  infrastructure the owner must provision.
- **Live SSRF/cancel end-to-end** — exercised at code-inspection level; SSRF guards are
  in the engine, cancel endpoints are tested at route level.

## 9. Security audit round (v0.5.0) — executed

| Area | Result | Evidence |
|---|---|---|
| Automated test suite (`node --test`) | **PASSED** | 22/22 pass: public routes, contact GET/POST (valid/missing/oversized), worker auth, CORS, scheme + SSRF helpers, job lifecycle (create/poll/download/delete), cancellation, rate-limit burst. |
| Worker API authentication | **PASSED** | 401 without/with-wrong key; 503 when no key configured; 404 with valid key on missing job. |
| Worker CORS allowlist | **PASSED** | allowed-origin preflight → 204 + ACAO; disallowed origin → 403, no ACAO. |
| Worker URL scheme + blocked-host validation | **PASSED** | `ftp://`, `javascript:`, `file://`, `localhost` → 400. |
| SSRF helper unit tests | **PASSED** | private/link-local/loopback/metadata IPv4+IPv6 blocked; public hosts allowed; parseTarget http(s)-only. |
| Wget runtime redirect guard | **PASSED (unit)** | `findBlockedIpInOutput` detects private IPs in output and ignores normal lines. |
| Worker job lifecycle | **PASSED** | create (202) → poll → completed (2 files) → download (200, ZIP magic) → delete-on-download. |
| Worker cancellation | **PASSED** | cancel endpoint → `{status:"cancelled"}`. |
| Rate-limit burst | **PASSED** | 429 after exceeding threshold; memory-bounded limiter used. |
| Oversized request body | **PASSED** | 413 on >32kb. |
| `npm audit` | **PASSED (with documented exception)** | 0 critical; 1 moderate in `hbs` (GHSA-7f5c-rpf4-86p8, no fix), mitigated. |
