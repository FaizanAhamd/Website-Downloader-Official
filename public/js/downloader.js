/**
 * Website Downloader — frontend logic.
 *
 * Two modes (no Socket.IO dependency):
 *  1. HTTP download API (default): POST /api/download mirrors a small public
 *     site and streams a ZIP back. Works in a Vercel serverless function.
 *  2. Worker polling mode (when window.WD_WORKER_PROXY is true): drives the
 *     authenticated worker proxy via job-status polling (opt-in via WORKER_URL).
 *
 * The UI uses an indeterminate progress bar because no genuine overall
 * percentage is available. No fake progress; no success when the request fails.
 */
(function () {
  'use strict';

  var WORKER_PROXY = (typeof window !== 'undefined' && window.WD_WORKER_PROXY === true);
  var HTTP_API = (typeof window !== 'undefined' && window.WD_DOWNLOAD_API === true);
  var workerMode = WORKER_PROXY; // false -> HTTP mode (default)

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

  var workerJobId = null;
  var workerTimer = null;
  var activeController = null; // AbortController for the HTTP mode

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
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', '0');
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

  /* ---------------- Shared actions ---------------- */

  function resetToIdle() {
    stopPolling();
    activeController = null;
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

  function showFailure(message) {
    hideProgress();
    stopPolling();
    downloadBtn.disabled = false;
    input.disabled = false;
    setError(String(message));
  }

  function showCompleted(message, detail) {
    hideProgress();
    downloadBtn.disabled = false;
    input.disabled = false;
    successMsg.textContent = message;
    resultFiles.textContent = detail || '';
    resultBlock.hidden = false;
    if (resultBlock.scrollIntoView) resultBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ============ MODE 1: HTTP download API (default) ============ */

  function triggerBlobDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function httpStart(raw) {
    var controller = new AbortController();
    activeController = controller;

    fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw }),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return { error: 'The download failed (HTTP ' + res.status + ').' }; })
            .then(function (payload) {
              showFailure(payload.error || 'The download failed (HTTP ' + res.status + ').');
              return null;
            });
        }
        return res.blob();
      })
      .then(function (blob) {
        if (!blob) return;
        // The server sets Content-Disposition; the browser honours it, but we
        // also provide a stable local fallback filename.
        var filename = 'website-' + Math.floor(Date.now() / 1000) + '.zip';
        triggerBlobDownload(blob, filename);
        // In HTTP mode there is no server-side ZIP link; hide that control.
        zipBtn.style.display = 'none';
        zipNameEl.textContent = '';
        showCompleted('Your website archive was downloaded.', 'ZIP saved to your browser’s downloads folder. Only static resources were captured; dynamic or protected content may be missing.');
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          showFailure('Download cancelled.');
          return;
        }
        showFailure('Could not reach the download service: ' + (err && err.message ? err.message : 'unknown error'));
      });
  }

  /* ============ MODE 2: Worker polling (opt-in) ============ */

  function stopPolling() {
    if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
  }

  function pollJob(id) {
    stopPolling();
    fetch('/api/jobs/' + id)
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
      .then(function (job) {
        if (job.status === 'completed') {
          hideProgress();
          downloadBtn.disabled = false;
          input.disabled = false;
          zipBtn.style.display = '';
          zipNameEl.textContent = job.file || '';
          zipBtn.href = '/api/jobs/' + id + '/download';
          showCompleted('Your ZIP archive is ready.', (job.files || 0) + ' files collected. The archive is stored temporarily and removed after download.');
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

    if (workerMode) { workerStart(raw); } else { httpStart(raw); }
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
      } else if (activeController) {
        activeController.abort();
      }
      hideProgress();
      downloadBtn.disabled = false;
      input.disabled = false;
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
    // No Socket.IO connection is needed in either mode.
  }
})();
