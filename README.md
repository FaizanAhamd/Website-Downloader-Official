# Website Downloader 💾

**Product owner and maintainer:** Faizan Ahmad
**Contact:** faizanraki42@gmail.com
**GitHub:** https://github.com/FaizanAhamd/Website-Downloader
**Original author:** Ahmed Ibrhim (2019) — see `LICENSE.md`

Mirror publicly accessible static website content (HTML, CSS, images and JavaScript files) and download the collected files as a single ZIP archive.

> This tool mirrors publicly accessible web pages only. It cannot retrieve a site's private backend source code, databases or server configuration. Download only content you are authorized to access and store.

## Features

- Responsive, professional UI for desktop, tablet and mobile.
- Real-time download status via Socket.IO.
- Live Wget log output and file counter.
- Indeterminate progress indicator (no fake percentages).
- ZIP archive generation.
- Temporary, private archive storage with delete-on-download.
- Configurable product branding and contact information via environment variables.
- Security protections: SSRF guard, private/localhost/IPv4/IPv6 blocking, DNS pinning, redirect checks, cloud metadata blocking, quotas, timeouts and concurrent-job limits.
- Public pages: Home, Features, How It Works, Guides (4 original educational guides), FAQ, About, Contact, Privacy Policy, Terms of Service, custom 404.
- SEO: per-page metadata, Open Graph / Twitter Card, canonical URLs, `robots.txt`, `sitemap.xml`.
- Optional Google AdSense integration (disabled by default, gated by environment).

## Requirements

- Node.js 18 or newer.
- GNU Wget installed and available to the application, or configure `WGET_PATH`. On Windows a bundled `wget.exe` is provided.

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then open `http://localhost:3000`.

Development mode: `npm run dev`.

The app loads `.env` automatically via `dotenv` (see `bin/www`).

## Configuration

See `.env.example` and `ENVIRONMENT_VARIABLES.md`. All settings are environment-driven via `config.js`.

## ZIP archive retention

Archives are written to a private folder (`private/archives/` by default) — never inside `public/`. They are deleted automatically after the configured retention period (`DOWNLOAD_ZIP_TTL_HOURS`, default 24 hours) and immediately after a successful download via the `/download/:file` route. Archive files are not served as public static assets.

## Technology stack

- Node.js / Express 4 / Handlebars (`hbs`)
- Socket.IO (local progress) with an HTTP **polling mode** for the worker deployment
- GNU Wget download engine + Archiver ZIP generation
- Environment-driven configuration (`config.js`, `dotenv`)

