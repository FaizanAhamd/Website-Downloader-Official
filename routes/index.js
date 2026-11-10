var express = require('express');
var path = require('path');
var fs = require('fs');
var createError = require('http-errors');
var config = require('../config');
var guides = require('../data/guides');
var router = express.Router();

// Per-page SEO metadata. Each public page gets a unique description and its
// own canonical path (the full canonical URL is assembled from
// config.brand.siteUrl + path in the layout). Fallbacks keep pages safe even if
// a page is missing from this map.
var DEFAULT_META_DESCRIPTION =
  'Mirror publicly accessible web pages and their linked resources. Download the collected files in one convenient ZIP archive with Website Downloader.';

var SEO_META = {
  index: {
    description: 'Download any public website online as a ZIP. Mirror entire sites for offline browsing with this free website downloader and website mirroring tool.',
    canonical: '/',
  },
  about: {
    description: 'Learn about Website Downloader, the free online tool to download an entire website for offline browsing and save it as a ZIP archive.',
    canonical: '/about',
  },
  features: {
    description: 'Explore Website Downloader features: download entire websites, mirror static resources, save websites as ZIP, with real-time progress.',
    canonical: '/features',
  },
  'how-it-works': {
    description: 'See how to download a website for offline browsing in three simple steps with Website Downloader, the free website mirroring tool.',
    canonical: '/how-it-works',
  },
  guides: {
    description: 'Read Website Downloader guides on how to download an entire website, mirror sites for offline browsing, and save a website as a ZIP archive.',
    canonical: '/guides',
  },
  guide: {
    description: 'Step-by-step guide to downloading a website for offline browsing with Website Downloader, the free website mirroring and save-as-ZIP tool.',
    canonical: '/guides',
  },
  faq: {
    description: 'Frequently asked questions about Website Downloader: downloading entire websites, website mirroring, and saving websites as ZIP files.',
    canonical: '/faq',
  },
  contact: {
    description: 'Contact the Website Downloader team about the free website downloader, website mirroring tool and saving websites as ZIP archives.',
    canonical: '/contact',
  },
  privacy: {
    description: 'Privacy policy for Website Downloader, the free online website downloader that mirrors websites for offline browsing and saves them as ZIP.',
    canonical: '/privacy',
  },
  terms: {
    description: 'Terms of service for Website Downloader, the free website downloader and mirroring tool for downloading entire websites as ZIP archives.',
    canonical: '/terms',
  },
};

// Guarantee the private archive directory exists (fresh clones start empty).
try {
  fs.mkdirSync(path.resolve(config.download.archiveDir), { recursive: true });
} catch (err) {
  console.error('Could not create archive directory:', err.message);
}

// Tracks how many clients are currently streaming a given ZIP. An archive is
// only deleted after the LAST active download of it finishes, so two users
// downloading the same file simultaneously cannot cause one to get a truncated
// response because the other's completion removed the file from under them.
var zipDownloadCounts = Object.create(null);

function page(res, view, title, extra, canonicalOverride) {
  var seo = SEO_META[view] || {};
  var meta = {
    description: seo.description || DEFAULT_META_DESCRIPTION,
    canonical: canonicalOverride || seo.canonical || '',
  };
  res.render(view, Object.assign({ title: title, meta: meta }, extra || {}));
}

/* ---------------- Public marketing pages ---------------- */

router.get('/', function (req, res, next) {
  page(res, 'index', 'Website Downloader - Download and Mirror Websites');
});

router.get('/about', function (req, res, next) {
  page(res, 'about', 'About Us - Website Downloader');
});

router.get('/features', function (req, res, next) {
  page(res, 'features', 'Features - Website Downloader');
});

router.get('/how-it-works', function (req, res, next) {
  page(res, 'how-it-works', 'How It Works - Website Downloader');
});

router.get('/guides', function (req, res, next) {
  page(res, 'guides', 'Guides - Website Downloader', { guides: guides.list });
});

router.get('/guides/:slug', function (req, res, next) {
  var guide = guides.get(req.params.slug);
  if (!guide) return next(createError(404));
  page(res, 'guide', guide.title + ' - Website Downloader', {
    guide: guide,
    related: guides.related(guide.slug),
  }, '/guides/' + guide.slug);
});

router.get('/faq', function (req, res, next) {
  page(res, 'faq', 'FAQ - Website Downloader');
});

router.get('/contact', function (req, res, next) {
  page(res, 'contact', 'Contact Us - Website Downloader', { sent: false });
});

// Lightweight fixed-window rate limit for the contact form.
// Uses the shared memory-bounded limiter. Only the socket peer address is
// trusted — the client-controlled X-Forwarded-For header is ignored.
var createRateLimit = require('../lib/rate-limit');
var clientIp = require('../lib/client-ip');
var contactLimit = createRateLimit({ windowMs: 60 * 1000, max: 10, maxEntries: 1000 });
function contactRateLimited(req) {
  // Proxy-aware real client IP (respects the configured trust proxy). The raw
  // X-Forwarded-For header is never trusted directly.
  return contactLimit.check(clientIp(req));
}

// Simple contact form — validates input and prepares a mailto: compose link so
// the visitor sends the message from their own email client. The server has no
// email delivery service connected, so we never claim a message was delivered.
// The "success" state only offers a real, working send path via mailto.
router.post('/contact', function (req, res, next) {
  if (contactRateLimited(req)) {
    return page(res, 'contact', 'Contact Us - Website Downloader', {
      composed: false,
      error: 'Too many attempts. Please try again shortly.',
      values: req.body || {},
    });
  }

  var body = req.body || {};
  var name = String(body.name || '').trim();
  var email = String(body.email || '').trim();
  var message = String(body.message || '').trim();

  if (!name || !email || !message) {
    return page(res, 'contact', 'Contact Us - Website Downloader', {
      composed: false,
      error: 'Please fill in all required fields.',
      values: body,
    });
  }

  var subject = encodeURIComponent('Website Downloader contact from ' + name);
  var text = encodeURIComponent(message + '\n\n— ' + name + ' (' + email + ')');
  var mailto = 'mailto:' + encodeURIComponent(config.brand.contactEmail) +
    '?subject=' + subject + '&body=' + text;

  page(res, 'contact', 'Contact Us - Website Downloader', {
    composed: true,
    mailto: mailto,
    contactEmail: config.brand.contactEmail,
  });
});

router.get('/privacy', function (req, res, next) {
  page(res, 'privacy', 'Privacy Policy - Website Downloader');
});

router.get('/terms', function (req, res, next) {
  page(res, 'terms', 'Terms of Service - Website Downloader');
});

/* ---------------- downloader ---------------- */

router.get('/download/:file', function (req, res, next) {
  var name = req.params.file || '';
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(name)) return next(createError(404));

  var archiveDir = path.resolve(config.download.archiveDir);
  var resolved = path.resolve(archiveDir, name);
  if (!resolved.startsWith(archiveDir + path.sep)) return next(createError(404));

  // Only delete the archive once the last active download of it finishes.
  zipDownloadCounts[name] = (zipDownloadCounts[name] || 0) + 1;

  res.download(resolved, name, function (dlErr) {
    if (dlErr) {
      console.error('ZIP download failed:', name, dlErr.message);
    }

    zipDownloadCounts[name] = Math.max(0, (zipDownloadCounts[name] || 1) - 1);
    if (zipDownloadCounts[name] > 0) return; // another client is still streaming

    delete zipDownloadCounts[name];
    fs.unlink(resolved, function (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.error('Could not delete archive:', name, unlinkErr.message);
      } else if (!unlinkErr) {
        console.log('Deleted archive after download:', name);
      }
    });
  });
});

/* ---------------- SEO / verification files ---------------- */

// Resolve the production site base URL. Only the explicitly configured
// PUBLIC_SITE_URL is trusted. When it is missing we deliberately do NOT read
// the request Host header (untrusted / open to cache-poisoning), and the
// sitemap is not published.
function configuredSiteUrl() {
  return (config.brand.siteUrl || '').replace(/\/$/, '');
}

// robots.txt — omits the Sitemap line until a production domain is configured,
// so we never advertise a placeholder or host-derived sitemap.
router.get('/robots.txt', function (req, res, next) {
  var siteUrl = configuredSiteUrl();
  res.type('text/plain');
  res.send(
    'User-agent: *\n' +
    'Disallow: /download/\n' +
    'Disallow: /socket.io/\n' +
    (siteUrl ? 'Sitemap: ' + siteUrl + '/sitemap.xml\n' : '')
  );
});

// sitemap.xml — generated only from the configured production domain. If no
// domain is configured, return 404 so no placeholder/misleading URLs are ever
// published.
router.get('/sitemap.xml', function (req, res, next) {
  var siteUrl = configuredSiteUrl();
  if (!siteUrl) return next(createError(404));
  var urls = [
    '', '/about', '/features', '/how-it-works', '/guides', '/faq',
    '/contact', '/privacy', '/terms',
  ];
  guides.list.forEach(function (g) { urls.push('/guides/' + g.slug); });

  var now = new Date().toISOString();
  var body = '<?xml version="1.0" encoding="UTF-8"?>\n';
  body += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  urls.forEach(function (u) {
    body += '  <url>\n';
    body += '    <loc>' + siteUrl + u + '</loc>\n';
    body += '    <lastmod>' + now + '</lastmod>\n';
    body += '    <changefreq>weekly</changefreq>\n';
    body += '    <priority>' + (u === '' ? '1.0' : '0.7') + '</priority>\n';
    body += '  </url>\n';
  });
  body += '</urlset>\n';

  res.type('application/xml');
  res.send(body);
});

module.exports = router;
