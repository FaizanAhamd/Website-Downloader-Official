var createError = require('http-errors');
var express = require('express');
var path = require('path');
var fs = require('fs');
var logger = require('morgan');
var hbs = require('hbs');

var config = require('./config');
var indexRouter = require('./routes/index');

var app = express();

// Trust proxy hops per configuration (used for safe client-IP extraction in
// rate limiting). See config.app.trustProxy.
app.set('trust proxy', config.app.trustProxy);

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// Register partials synchronously with explicit names (e.g. ad-unit) so they
// are guaranteed available at render time. hbs.registerPartials is async.
try {
  var partialsDir = path.join(__dirname, 'views', 'partials');
  fs.readdirSync(partialsDir).forEach(function (file) {
    if (/\.hbs$/.test(file)) {
      var name = file.replace(/\.hbs$/, '');
      var src = fs.readFileSync(path.join(partialsDir, file), 'utf8');
      hbs.handlebars.registerPartial(name, src);
    }
  });
} catch (partialErr) {
  console.error('Could not register partials:', partialErr.message);
}

app.use(logger('dev'));

// Body parsing (registered before routes). Size-bounded; oversized bodies are
// rejected with a 413 by Express's default body-parser behavior.
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

app.use(express.static(path.join(__dirname, 'public')));

// Inject runtime config into every view (nav, contact, canonical, API base).
app.use(function (req, res, next) {
  res.locals.config = config;
  next();
});

app.use('/', indexRouter);

// Optional server-side worker proxy (authenticated). Mounted before the 404
// catch-all so public users can use the downloader via their own origin without
// the worker API key ever reaching browser code. This is the Vercel-compatible
// path: the Wget engine itself runs in the external worker (never in a
// serverless function).
if (config.worker.enabled) {
  app.use('/api/jobs', require('./routes/worker-proxy'));
}

// catch 404 and forward to the custom 404 page
app.use(function (req, res, next) {
  res.status(404).render('404', { title: 'Page Not Found - Website Downloader' });
});

// error handler
app.use(function (err, req, res, next) {
  var status = err.status || 500;
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  if (status === 404) {
    return res.status(404).render('404', { title: 'Page Not Found - Website Downloader' });
  }

  res.status(status);
  res.render('error');
});

module.exports = app;
