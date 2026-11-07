/**
 * routes/worker-proxy.js — server-side proxy to the download worker.
 *
 * The public frontend talks to its OWN origin (/api/jobs...). This router
 * forwards those requests to the configured worker (WORKER_URL) attaching the
 * worker API key (WORKER_API_KEY) from the server environment. The key is
 * never exposed to browser JavaScript, and arbitrary origins can never call the
 * worker directly.
 *
 * Mounted in app.js only when config.worker.url is set, e.g.:
 *   app.use('/api/jobs', require('./routes/worker-proxy'));
 */
'use strict';

var express = require('express');
var config = require('../config');
var router = express.Router();

function workerBase() {
  return (config.worker.url || '').replace(/\/$/, '');
}

// Forward an authenticated request to the worker and relay the response.
function forward(req, res, path, method, body) {
  var apiKey = config.worker.apiKey;
  if (!workerBase() || !apiKey) {
    return res.status(503).json({ error: 'Worker is not configured.' });
  }
  var proto = req.headers['x-forwarded-proto'] || 'http';
  var baseUrl = proto + '://' + (req.get('host') || 'localhost');
  var headers = {
    Authorization: 'Bearer ' + apiKey,
  };
  if (body) headers['Content-Type'] = 'application/json';

  fetch(workerBase() + '/api/jobs' + path, { method: method, headers: headers, body: body })
    .then(function (up) {
      res.status(up.status);
      var ct = up.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return up.json().then(function (j) { res.json(j); });
      }
      // Streaming download (ZIP).
      if (up.body) {
        var cd = up.headers.get('content-disposition');
        if (cd) res.setHeader('Content-Disposition', cd);
        res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
        return new Response(up.body).body.pipeTo(new WritableStream({
          write: function (chunk) { res.write(chunk); },
          close: function () { res.end(); },
          abort: function () { res.destroy(); },
        }));
      }
      res.end();
    })
    .catch(function (err) {
      res.status(502).json({ error: 'Worker unreachable: ' + err.message });
    });
}

router.post('/', function (req, res) {
  forward(req, res, '', 'POST', JSON.stringify({ url: req.body && req.body.url }));
});

router.get('/:id', function (req, res) {
  forward(req, res, '/' + req.params.id, 'GET');
});

router.post('/:id/cancel', function (req, res) {
  forward(req, res, '/' + req.params.id + '/cancel', 'POST');
});

router.get('/:id/download', function (req, res) {
  forward(req, res, '/' + req.params.id + '/download', 'GET');
});

module.exports = router;
