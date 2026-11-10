/**
 * Website Downloader — frontend logic.
 *
 * Two modes, both driven by the ORIGINAL Wget engine:
 *  1. Classic Socket.IO mode (default): same-origin. Mirrors the server event
 *     protocol keyed by a client token:
 *       { progress: 'Starting' } | { progress: '<wget output>' }
 *       { progress: 'Converting' } | { progress: 'Completed', file, files }
 *       { error: '...' }
 *  2. Worker-polling mode (when window.WD_WORKER_PROXY is true): drives the
 *     authenticated worker proxy via job-status polling. The worker runs the
 *     same Wget engine (required for Vercel, where a serverless function cannot
 *     run Wget).
 */
(function () {
  'use strict';

  var WORKER_PROXY = (typeof window !== 'undefined' && window.WD_WORKER_PROXY === true);
  var workerMode = WORKER_PROXY;

  var form = document.getElementById('download-form');
  var input = document.getElementById('url-input');
  var errorEl = document.getElementById('url-error');
  var downloadBtn = document.getElementById('download-btn');

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

  var socket = null;
  var token = null;
  var workerJobId = null;
  var workerTimer = null;

  /* ---------------- UI helpers ---------------- */

  function setError(text) {
    errorMsg.textContent = text;
    errorBanner.hidden = false;
  }

  function clearError() {
    if (errorBanner) { errorBanner.hidden = true; errorMsg.textContent = ''; }
  }

  /**
   * Send a GA4 event (only when the global tag is present). No event carries any
   * sensitive parameter — no URLs, tokens, emails, error strings or filenames.
   * Consent filtering is handled by Google Consent Mode on the gtag side.
   */
  function trackEvent(eventName) {
    if (typeof window.gtag !== 'function') return;
    try { window.gtag('event', eventName); } catch (e) { /* never break the UI */ }
  }

  function setStatus(text) {
    statusText.textContent = text;
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', '0');
  }

  function showProgress() {
    progressBlock.hidden = false;
    resultBlock.hidden = true;
    clearError();
    if (progressBar) progressBar.classList.add('indeterminate');
    cancelBtn.hidden = false;
  }

  function hideProgress() {
    progressBlock.hidden = true;
    cancelBtn.hidden = true;
  }

  function setFileCount(count) {
    fileCountEl.textContent = count === 1 ? '1 file' : count + ' files';
  }

  function appendLog(text) {
    if (!text) return;
    var line = text.replace(/\r/g, '');
    if (logEl.textContent) logEl.textContent += '\n';
    logEl.textContent += line;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function showFailure(message, opts) {
    hideProgress();
    stopPolling();
    downloadBtn.disabled = false;
    input.disabled = false;
    setError(String(message));
    // Track real download failures; a cancellation is not a failure.
    if (!opts || opts.track !== false) trackEvent('download_failed');
  }

  function showCompleted(file, files, url) {
    hideProgress();
    downloadBtn.disabled = false;
    input.disabled = false;
    setFileCount(files || 0);
    zipNameEl.textContent = file || '';
    if (file && url) {
      zipBtn.href = url;
      zipBtn.style.display = '';
      zipBtn.setAttribute('download', file);
    } else if (file) {
      // Fallback for any consumer that only provides the file name.
      zipBtn.href = '/download/' + encodeURIComponent(file);
      zipBtn.style.display = '';
      zipBtn.setAttribute('download', file);
    } else {
      zipBtn.style.display = 'none';
    }
    successMsg.textContent = 'Your ZIP archive is ready.';
    resultFiles.textContent = (files || 0) + ' files collected. The archive is stored temporarily and removed after download.';
    resultBlock.hidden = false;
    // Server has confirmed the archive is created and ready.
    trackEvent('archive_ready');
  }

  function resetToIdle() {
    stopPolling();
    socket = null;
    token = null;
    input.value = '';
    input.disabled = false;
    downloadBtn.disabled = false;
    clearError();
    hideProgress();
    resultBlock.hidden = true;
    if (logEl) logEl.textContent = '';
    setFileCount(0);
    workerJobId = null;
    zipBtn.style.display = '';
    zipNameEl.textContent = '';
  }

  /* ============ MODE 1: Classic Socket.IO (Wget engine) ============ */

  function handleEvent(evt) {
    if (!evt) return;
    if (evt.error) { showFailure(evt.error); return; }
    if (evt.progress === 'Completed') {
      showCompleted(evt.file, evt.files, evt.url);
      return;
    }
    if (evt.progress === 'Converting') {
      setStatus('Website download complete. Creating ZIP archive…');
      return;
    }
    if (evt.progress === 'Starting') {
      setStatus('Starting…');
      return;
    }
    // Otherwise this is a live Wget output line.
    setStatus('Downloading…');
    appendLog(evt.progress);
  }

  function socketStart(raw) {
    if (typeof window.io === 'undefined') {
      showFailure('Connection error: Socket.IO client not loaded.');
      return;
    }
    token = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    var disconnectedOnce = false;
    socket = window.io();

    socket.on(token, handleEvent);

    socket.on('disconnect', function () {
      // A temporary transport drop must NOT kill the download. The server keeps
      // the job running; we show "reconnecting" and rely on socket.io's
      // automatic reconnection + the 'sync' handshake to recover the state.
      if (!progressBlock.hidden) {
        disconnectedOnce = true;
        setStatus('Connection lost. Reconnecting…');
        if (cancelBtn) cancelBtn.disabled = true;
      }
    });

    socket.on('connect', function () {
      // On reconnect, ask the server for the job's authoritative state so the
      // UI can recover (completed/failed/converting/running) instead of being
      // stuck on the stale state.
      if (disconnectedOnce && token && !progressBlock.hidden) {
        socket.emit('sync', { token: token });
        if (cancelBtn) cancelBtn.disabled = false;
      }
    });

    socket.on('connect_error', function () {
      if (!progressBlock.hidden) {
        setStatus('Could not connect to the download engine. Retrying…');
      } else {
        showFailure('Could not connect to the download engine. Please try again.');
      }
    });

    showProgress();
    setStatus('Starting…');
    setFileCount(0);
    downloadBtn.disabled = true;
    input.disabled = true;
    socket.emit('request', { website: raw, token: token });
  }

  /* ============ MODE 2: Worker polling (Vercel proxy) ============ */

  function stopPolling() {
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
  }

  function pollJob(id) {
    stopPolling();
    fetch('/api/jobs/' + id)
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (job) {
        if (job.status === 'completed') {
          showCompleted(job.file, job.files, job.downloadUrl);
          return;
        }
        if (job.status === 'failed') { showFailure(job.error || 'Download failed.'); return; }
        if (job.status === 'cancelled') { showFailure('Download cancelled.', { track: false }); return; }
        if (job.status === 'converting') {
          showProgress();
          setStatus('Website download complete. Creating ZIP archive…');
          cancelBtn.hidden = true;
        } else if (job.status === 'running') {
          showProgress();
          setStatus('Downloading…');
          if (job.log && logEl) {
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

  /* ---------------- Wiring ---------------- */

  function startDownload(raw) {
    clearError();
    setFileCount(0);
    if (logEl) logEl.textContent = '';
    showProgress();
    setStatus('Starting…');
    downloadBtn.disabled = true;
    input.disabled = true;

    if (workerMode) { workerStart(raw); } else { socketStart(raw); }
    // A valid download request was submitted.
    trackEvent('download_started');
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

  if (form) {
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function () {
      if (workerMode && workerJobId) {
        fetch('/api/jobs/' + workerJobId + '/cancel', { method: 'POST' }).catch(function () {});
        stopPolling();
      } else if (socket) {
        try { socket.emit('cancel', { token: token }); } catch (e) { /* noop */ }
      }
      trackEvent('download_cancelled');
      hideProgress();
      downloadBtn.disabled = false;
      input.disabled = false;
    });
  }

  // A ZIP download click is a genuine user interaction.
  if (zipBtn) {
    zipBtn.addEventListener('click', function () {
      trackEvent('zip_download_clicked');
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', function () { resetToIdle(); input.focus(); });
  }

  if (input && errorEl) {
    input.addEventListener('input', function () { errorEl.hidden = true; });
  }
})();
