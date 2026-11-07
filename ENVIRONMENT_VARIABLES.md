# Environment Variables

All settings are environment-driven via `config.js`. Copy `.env.example` to `.env`
locally; on Vercel, set the same variables in the project settings. None of these are
secrets — they are branding, feature flags and engine tunables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (local only; Vercel sets its own). |
| `TRUST_PROXY` | *(empty)* | Reverse-proxy trust for safe client-IP extraction (rate limiting). Accepts `true`, a hop count (`1`), or a comma-separated list of trusted proxy IPs (recommended). Leave empty = trust no proxy (direct socket address). |
| `PUBLIC_PRODUCT_NAME` | `Website Downloader` | Product/brand name. |
| `PUBLIC_PRODUCT_OWNER` | `Faizan Ahmad` | Owner / maintainer name. |
| `PUBLIC_GITHUB_URL` | GitHub URL | Repository link used across the UI. |
| `PUBLIC_CONTACT_EMAIL` | `faizanraki42@gmail.com` | Public contact email (shown when set). |
| `PUBLIC_BUSINESS_ADDRESS` | *(empty)* | Optional business address (hides if empty). |
| `PUBLIC_SITE_URL` | *(empty)* | Production domain, e.g. `https://website-downloader.vercel.app`. Used for canonical URLs, Open Graph and `robots.txt`/`sitemap.xml`. Hide if empty. |
| `ADSENSE_ENABLED` | `false` | Set to `true` only after Google verification & ad units are ready. |
| `ADSENSE_PUBLISHER_ID` | `pub-3385240797900631` | Publisher ID (must be verified against the real AdSense account before production). |
| `DOWNLOAD_QUOTA` | `100m` | Max total download size per job (wget quota). |
| `DOWNLOAD_TIMEOUT_MS` | `300000` | Per-job timeout in ms. |
| `DOWNLOAD_WATCHDOG_MS` | `2000` | Watchdog interval in ms. |
| `MAX_CONCURRENT_DOWNLOADS` | `5` | Max simultaneous downloads. |
| `DOWNLOAD_ZIP_TTL_HOURS` | `24` | ZIP archive retention before sweep. |
| `WGET_PATH` | *(empty)* | Override wget binary path. On Windows the bundled `wget.exe` is used. |
| `ARCHIVE_DIR` | `private/archives` | Private ZIP storage directory (never under `public/`). |
| `API_BASE_URL` | *(empty)* | Legacy frontend worker-mode base; kept for compatibility. Prefer `WORKER_URL` on the server so the browser uses the same-origin proxy. |
| `WORKER_URL` | *(empty)* | Main-app: URL of the download worker. When set, the app mounts an authenticated server-side proxy at `/api/jobs`; the frontend runs in worker polling mode through it. |
| `WORKER_API_KEY` | *(empty)* | Worker: required bearer key for all `/api/jobs*` endpoints. Also set on the main app so its proxy can authenticate. Never exposed to browsers. |
| `WORKER_CORS_ORIGIN` | *(empty)* | Worker: comma-separated allowlist of origins permitted cross-origin. When empty, no cross-origin access is granted. |
| `ARCHIVE_UPLOAD_URL` | *(empty)* | Worker-only. Optional POST endpoint to mirror finished ZIP archives (e.g. an S3-compatible presigned URL). When set, a job completes only after a successful 2xx upload. Disabled when empty. |
| `WORKER_PORT` / `PORT` (worker) | `3200` | Port for the standalone worker (`node worker/server.js`). |
| `VERCEL_WORKER_API_URL` | *(empty)* | Documented reference for the deployed worker URL (set `WORKER_URL` to it on Vercel). |
| `ZIP_STORAGE_BUCKET` | *(empty)* | Reserved for future object storage. |

## Worker service (separate process)

The worker (`worker/server.js`) is a standalone HTTP service that reuses the Wget/archiver
engine and exposes a polling API. It uses the same download engine variables
(`DOWNLOAD_QUOTA`, `DOWNLOAD_TIMEOUT_MS`, `DOWNLOAD_WATCHDOG_MS`,
`MAX_CONCURRENT_DOWNLOADS`, `DOWNLOAD_ZIP_TTL_HOURS`, `WGET_PATH`, `ARCHIVE_DIR`).
Run with `node worker/server.js`. It is intentionally separate from the Vercel app
because serverless functions cannot run Wget or hold long-running jobs.

### Authentication flow (frontend → API → worker)

1. The browser only ever talks to its own origin (the Vercel app).
2. The app mounts an authenticated proxy at `/api/jobs` (enabled when `WORKER_URL` is set).
3. The proxy forwards requests to the worker, attaching `Authorization: Bearer $WORKER_API_KEY`.
4. The worker rejects any request without a valid key.
5. The worker API key is an environment secret on both the app and the worker — it never
   appears in HTML/JS sent to browsers.
