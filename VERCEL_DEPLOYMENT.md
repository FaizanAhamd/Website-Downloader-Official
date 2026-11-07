# Vercel Deployment — Architecture Guide

**This is a plan, not an active deployment.** The classic app runs as a Node.js/Express
server with GNU Wget and a local filesystem. It is **not** fully Vercel-ready as-is,
because the download engine cannot run inside a serverless function.

## What Vercel can serve today

The **marketing/SEO pages** (Home, Features, How It Works, Guides, FAQ, About, Contact,
Privacy, Terms, 404) and the static UI are served by the Express app. A Vercel
configuration (`vercel.json` + `api/index.js`) is included so these pages can be deployed
to Vercel Hobby. Set `PUBLIC_SITE_URL` to the assigned `*.vercel.app` (or custom) domain
so `robots.txt`, `sitemap.xml` and canonical URLs resolve correctly.

## Why the whole app cannot run unchanged on Vercel

- The download engine spawns **GNU Wget**, which is not available in Vercel's serverless runtime.
- The engine reads/writes a **local filesystem** (`downloads/`, `private/archives/`), which is not durable in serverless functions.
- Long-running jobs exceed serverless function time limits.
- The ZIP download route relies on local file delivery and delete-on-download.
- Socket.IO long-lived connections are not guaranteed on the edge.

## What a production download deployment requires

- **Vercel-compatible frontend/API** — the static UI and a thin API layer.
- **Durable job state** — jobs must survive across requests (a queue + a persisted status store).
- **External Docker-based Wget worker** — the actual mirroring runs in a long-lived container that has Wget installed, not in a serverless function.
- **Private object storage** — generated ZIP archives should go to object storage (e.g. S3-compatible) instead of the local filesystem.
- **HTTP job-status polling (or another deployment-compatible progress mechanism)** — replace/supplement Socket.IO with a polling endpoint.

> Do not attempt to run the downloader inside a serverless function. It will time out
> and cannot spawn Wget. Keep the engine on an always-on host or worker container.

## What is already prepared in this codebase

- `config.js` centralizes every env-driven setting.
- `public/js/downloader.js` supports **two modes**: classic same-origin Socket.IO
  (local) and worker polling via `API_BASE_URL` (production/Vercel).
- `worker/server.js` — a standalone, always-on download worker that reuses the Wget/
  archiver engine and exposes an HTTP polling API (`POST /api/jobs`, `GET /api/jobs/:id`,
  `POST /api/jobs/:id/cancel`, `GET /api/jobs/:id/download`, `/healthz`). It has
  rate limiting, concurrency caps and CORS built in.
- The Vercel frontend sets `API_BASE_URL` to the deployed worker URL; the UI then polls
  the worker instead of using a socket, so no long-lived connection is required on the edge.
- `api/index.js` + `vercel.json` are included so the marketing pages can deploy to Vercel.
- Environment variables are documented in `ENVIRONMENT_VARIABLES.md`.

## Deploying the worker (free-tier options)

The worker is a plain Node.js service. Examples of free/cheap always-on hosts: a small
VPS, a free-tier container host, or a free-tier app platform that keeps a process running.
Set its `PORT` (default 3200), `ARCHIVE_DIR`, engine limits, and optionally
`ARCHIVE_UPLOAD_URL` for object-storage archival.

## Environment variables

See `ENVIRONMENT_VARIABLES.md` for all supported variables. None are secrets; they are branding, engine tunables and feature flags.

## Limitations to document before deploying

- Long-running jobs require the external worker; never attempt them in a serverless function.
- Local filesystem ZIP storage must be replaced with object storage for the download path.
- Socket.IO long-polling works behind Vercel's edge but websocket transport may need configuration.
- Wget is not available in Vercel's runtime — the worker container must install it.

## Readiness status

| Item | Status |
|---|---|
| Vercel config (`vercel.json`, `api/index.js`) | **Ready for configuration** — single `@vercel/node` function serves the Express app (pages + static assets). |
| Marketing/SEO pages on Vercel | **Ready** — served by the Express app; all routes verified locally. |
| Downloader on Vercel | **Requires external worker** — the engine runs in `worker/server.js` (separate always-on host). Never run Wget inside a serverless function. |
| Worker ↔ frontend connectivity | **Ready for configuration** — set `WORKER_URL` + `WORKER_API_KEY` on Vercel and the worker; the app mounts an authenticated proxy at `/api/jobs`. |
| Socket.IO client script | **Fixed** — only loaded in classic local mode; omitted in worker-proxy mode (avoids a 404 on Vercel). |
| Persistent ZIP storage | **Requires external hosting** — worker uses local disk by default; enable `ARCHIVE_UPLOAD_URL` (S3-compatible) for durable storage. |
| Canonical / sitemap domain | **Requires configuration** — set `PUBLIC_SITE_URL`; until then `sitemap.xml` returns 404 and `robots.txt` omits the Sitemap line. |
| `TRUST_PROXY` | **Recommended** — set to your proxy IPs so rate-limit client-IP extraction is correct behind Vercel's edge. |

### Required environment variables on Vercel (Hobby)

- `PUBLIC_SITE_URL` — `https://<project>.vercel.app` (or custom domain).
- `WORKER_URL` — protocol/host of the deployed worker.
- `WORKER_API_KEY` — shared secret (also set on the worker).
- `TRUST_PROXY` — your proxy IPs (see `ENVIRONMENT_VARIABLES.md`).
- `WORKER_CORS_ORIGIN` — on the worker only, the Vercel origin(s).
- AdSense: leave `ADSENSE_ENABLED=false` until Google approves the site (see `ADSENSE_SETUP.md`).

### Deployment status

- **Not deployed.** No Vercel project exists and no live URL is claimed in this repository.
  Deployment requires owner action in the Vercel dashboard (import the GitHub repo, set the
  variables above, deploy).
