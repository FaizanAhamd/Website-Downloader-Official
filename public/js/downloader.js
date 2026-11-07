/**
 * Website Downloader — frontend logic.
 *
 * Two modes:
 *  1. Classic local mode (default): Socket.IO, same-origin. Mirrors the exact
 *     server event protocol keyed by a client token:
 *       { progress: 'Starting' } | { progress: '<wget output>' }
 *       { progress: 'Converting' } | { progress: 'Completed', file, files }
 *       { error: '...' }
 *  2. Worker mode (when the server has mounted the authenticated worker proxy):
 *     HTTP job-status polling — suitable for Vercel-hosted frontends that
 *     cannot run the download engine themselves.
 *
 * The UI uses an indeterminate progress bar because no genuine overall-percentage
 * is available. File counts are shown only from real data. No fake progress.
 */
(function () {
  'use strict';

  var PROXY = (typeof window !== 'undefined' && window.WD_WORKER_PROXY === true);
  var workerMode = PROXY;

  var form = document.getElementById('download-form');
  var input = document.getElementById('url-input');
  var errorEl = document.getElementById('url-error');
  var downloadBtn = document.getElementById('download-btn');

  var connStatus = document.getElementById('conn-status');
  var progressBlock = document.getElementById('progress-block');
  var progressTrack = document.getElementById('progress-track');
  var progressBar = document.getElementById('progress-bar');
  var statusText = document.getElementById('status-text');
  var fileCountEl = document.getElementById('file-count');
  var logEl = document.getElementById('log');
  var cancelBtn = document.getElementById('cancel-btn');

  var resultBlock = document.getElementById('result-block');
  var successMsg = document.getElementById('success-msg');
  var resultFiles = document.getElementById('result-files');
  var zipNameEl = document.getElementById('zip-name');
  var zipBtn = document.getElementById('zip-btn');

  var errorBanner = document.getElementById('error-banner');
  var errorMsg = document.getElementById('error-msg');
  var retryBtn = document.getElementById('retry-btn');

  var URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
  var token = getToken();
  var socket = null;
  var numberOfFiles = 0;
  var workerJobId = null;
  var workerTimer = null;

  /* ---------------- token helpers ---------------- */

  function generateToken(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var arr = new Uint32Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(arr);
      for (var i = 0; i < len; i++) out += chars[arr[i] % chars.length];
      return out;
    }
    for (var j = 0; j < len; j++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function getToken() {
    try {
      var t = localStorage.getItem('token');
      if (!t) { t = generateToken(20); localStorage.setItem('token', t); }
      return t;
    } catch (e) { return generateToken(20); }
  }

  /* ---------------- UI state helpers ---------------- */

  function setError(text) {
    errorMsg.textContent = text;
    errorBanner.hidden = false;
  }

  function clearError() {
    if (errorBanner) { errorBanner.hidden = true; errorMsg.textContent = ''; }
  }

  function setStatus(text) {
    statusText.textContent = text;
    progressTrack.setAttribute('aria-valuenow', '0');
  }

  function setFileCount(count) {
    numberOfFiles = count;
    fileCountEl.textContent = count === 1 ? '1 file' : count + ' files';
  }

  function showProgress() {
    progressBlock.hidden = false;
    resultBlock.hidden = true;
    clearError();
    progressBar.classList.add('indeterminate');
    cancelBtn.hidden = false;
  }

  function hideProgress() {
    progressBlock.hidden = true;
    cancelBtn.hidden = true;
  }

  function appendLog(text) {
    if (!text) return;
    var line = text.replace(/\r/g, '');
    if (logEl.textContent) logEl.textContent += '\n';
    logEl.textContent += line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function countSavedFiles(text) {
    var count = 0;
    var re = /saved\s+\[[^\]]*\]/i;
    var mapping = /['\u2018].*?['\u2019]\s*->/g;
    if (re.test(text)) count++;
    while (mapping.exec(text)) count++;
    return count;
  }

  /* ---------------- shared state machine ---------------- */

  function showCompleted(file, files) {
    hideProgress();
    downloadBtn.disabled = false;
    zipNameEl.textContent = file;
    zipBtn.href = workerMode
      ? '/api/jobs/' + workerJobId + '/download'
      : '/download/' + encodeURIComponent(file);
    resultFiles.textContent = files === 1 ? '1 file collected' : files + ' files collected';
    successMsg.textContent = 'Your ZIP archive is ready.';
    resultBlock.hidden = false;
    if (resultBlock.scrollIntoView) resultBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function showFailure(message) {
    hideProgress();
    stopPolling();
    downloadBtn.disabled = false;
    input.disabled = false;
    setError(String(message));
  }

  /* ============ MODE 1: Socket.IO (classic local) ============ */

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;

    if (event.error) { showFailure(event.error); return; }

    var progress = event.progress;

    if (progress === 'Completed') {
      hideProgress();
      downloadBtn.disabled = false;
      var file = String(event.file || '');
      var count = typeof event.files === 'number' ? event.files : numberOfFiles;
      showCompleted(file, count);
      return;
    }

    if (progress === 'Converting') {
      showProgress();
      setStatus('Website download completed. Creating ZIP archive…');
      cancelBtn.hidden = true;
      return;
    }

    if (typeof progress === 'string' && progress) {
      showProgress();
      setStatus('Downloading…');
      var added = countSavedFiles(progress);
      if (added > 0) setFileCount(numberOfFiles + added);
      appendLog(progress);
    }
  }

  function connect() {
    if (!window.io) {
      if (connStatus) { connStatus.textContent = 'Connection error: socket client not loaded.'; connStatus.classList.add('is-error'); connStatus.hidden = false; }
      return;
    }
    socket = window.io();

    socket.on('connect', function () { if (connStatus) connStatus.hidden = true; });

    socket.on('disconnect', function () {
      if (connStatus) { connStatus.textContent = 'Connection lost. Please try again.'; connStatus.classList.add('is-error'); connStatus.hidden = false; }
      downloadBtn.disabled = false;
      input.disabled = false;
    });

    socket.on(token, handleEvent);

    socket.on('connect_error', function () {
      if (connStatus) { connStatus.textContent = 'Could not connect. Please refresh and try again.'; connStatus.classList.add('is-error'); connStatus.hidden = false; }
    });
  }

  /* ============ MODE 2: Worker polling (HTTP) ============ */

  function stopPolling() {
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
  }

  function pollJob(id) {
    stopPolling();
    fetch('/api/jobs/' + id)
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (job) {
        if (job.status === 'completed') {
          showCompleted(job.file, job.files);
          return;
        }
        if (job.status === 'failed') { showFailure(job.error || 'Download failed.'); return; }
        if (job.status === 'cancelled') { showFailure('Download cancelled.'); return; }
        if (job.status === 'converting') {
          showProgress();
          setStatus('Website download completed. Creating ZIP archive…');
          cancelBtn.hidden = true;
        } else if (job.status === 'running') {
          showProgress();
          setStatus('Downloading…');
          if (job.log) {
            var lines = job.log.split('\n');
            for (var i = 0; i < lines.length; i++) {
              var added = countSavedFiles(lines[i]);
              if (added > 0) setFileCount(numberOfFiles + added);
            }
            logEl.textContent = job.log;
            logEl.scrollTop = logEl.scrollHeight;
          }
        }
        if (job.status === 'running' || job.status === 'converting') {
          workerTimer = setTimeout(function () { pollJob(id); }, 1200);
        }
      })
      .catch(function (err) { showFailure('Could not reach the download worker: ' + err.message); });
  }

  function workerStart(raw) {
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw }),
    })
      .then(function (r) { return r.json(); })
      .then(function (job) {
        if (job.error) { showFailure(job.error); return; }
        workerJobId = job.id;
        showProgress();
        setStatus('Starting…');
        pollJob(job.id);
      })
      .catch(function (err) { showFailure('Could not start the download worker: ' + err.message); });
  }

  /* ---------------- Actions ---------------- */

  function resetToIdle() {
    stopPolling();
    input.value = '';
    input.disabled = false;
    downloadBtn.disabled = false;
    clearError();
    hideProgress();
    resultBlock.hidden = true;
    logEl.textContent = '';
    setFileCount(0);
    workerJobId = null;
  }

  function startDownload(raw) {
    clearError();
    setFileCount(0);
    logEl.textContent = '';
    showProgress();
    setStatus('Starting…');
    downloadBtn.disabled = true;
    input.disabled = true;

    if (workerMode) { workerStart(raw); return; }
    socket.emit('request', { token: token, website: raw });
  }

  function submit() {
    var raw = (input.value || '').trim();
    if (!raw) {
      errorEl.textContent = 'Please enter a website URL.';
      errorEl.hidden = false;
      input.focus();
      return;
    }
    if (!URL_RE.test(raw)) {
      errorEl.textContent = 'That does not look like a public http(s) URL. Try https://example.com';
      errorEl.hidden = false;
      input.focus();
      return;
    }
    errorEl.hidden = true;
    startDownload(raw);
  }

  /* ---------------- Wiring ---------------- */

  if (form) {
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      if (workerMode && workerJobId) {
        fetch('/api/jobs/' + workerJobId + '/cancel', { method: 'POST' })
          .catch(function () {});
        stopPolling();
      } else if (socket) {
        socket.emit('cancel', { token: token });
      }
      hideProgress();
      downloadBtn.disabled = false;
      input.disabled = false;
      if (connStatus) { connStatus.textContent = 'Download cancelled.'; connStatus.hidden = false; }
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', function () { resetToIdle(); input.focus(); });
  }

  if (input && errorEl) {
    input.addEventListener('input', function () { errorEl.hidden = true; });
  }

  // Only activate the downloader on pages that actually contain it.
  if (form && input) {
    if (workerMode) { /* polling mode; no socket needed */ } else { connect(); }
  }
})();
