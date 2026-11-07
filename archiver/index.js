var archiver = require('archiver');
var fs = require('fs');
var path = require('path');
var config = require('../config');

var SITES_DIR = config.download.archiveDir;
var TTL_MS = config.download.zipTtlHours * 3600 * 1000;

/**
 * Zips sourceDir into <archiveDir>/<zipName>.zip and reports the outcome.
 * - Archives are written to a private directory, never public/.
 * - Failures remove partial files and never take the process down.
 * - Returns a control handle with abort() so cancellation can interrupt archiving.
 * - Old ZIPs are swept opportunistically (expiry policy, default 24h).
 */
module.exports = function (sourceDir, zipName, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  opts = opts || {};

  var settled = false;
  var output = null;
  var archive = null;
  var zipPath = path.join(SITES_DIR, zipName + '.zip');

  var finish = function (err, info) {
    if (settled) return;
    settled = true;
    if (err && output) {
      try { output.destroy(); } catch (e) {}
      try { fs.unlinkSync(zipPath); } catch (e) {}
    }
    callback(err, zipName, info);
  };

  try {
    fs.mkdirSync(SITES_DIR, { recursive: true });
  } catch (err) {
    finish(err);
    return { abort: function () {} };
  }

  output = fs.createWriteStream(zipPath);
  archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', function () {
    console.log(archive.pointer() + ' total bytes written to ' + zipPath);
    finish(null, {
      fileCount: opts.fileCount || countFilesSync(sourceDir),
      bytes: archive.pointer(),
    });
  });

  output.on('error', function (err) { finish(err); });

  archive.on('warning', function (err) {
    console.warn('archive warning: ' + err.message);
  });

  archive.on('error', function (err) { finish(err); });

  archive.pipe(output);
  archive.directory(sourceDir, false);
  archive.finalize();

  sweepOldZips();

  return {
    abort: function () {
      if (settled) return;
      try { if (output) output.destroy(); } catch (e) {}
      try { if (archive && archive.abort) archive.abort(); } catch (e) {}
      finish(new Error('Archiving was cancelled.'));
    },
  };
};

module.exports.sweep = sweepOldZips;

function countFilesSync(directory) {
  var total = 0;
  var entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (err) { return 0; }
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].isDirectory()) total += countFilesSync(path.join(directory, entries[i].name));
    else total++;
  }
  return total;
}

function sweepOldZips() {
  fs.readdir(SITES_DIR, function (err, names) {
    if (err) return;
    var now = Date.now();
    names.forEach(function (n) {
      if (!n.toLowerCase().endsWith('.zip')) return;
      var fp = path.join(SITES_DIR, n);
      fs.stat(fp, function (e, st) {
        if (e) return;
        if (now - st.mtimeMs > TTL_MS) {
          fs.unlink(fp, function () {
            console.log('Expired zip removed: ' + n);
          });
        }
      });
    });
  });
}