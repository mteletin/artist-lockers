(function() {
  var panel = document.querySelector('#panelTools');
  if (!panel) return;

  var statusEl = document.querySelector('#toolsStatus');
  var form = document.querySelector('#remasterUploadForm');
  var fileInput = document.querySelector('#remasterAudioFile');
  var fileName = document.querySelector('#remasterFileName');
  var submitButton = document.querySelector('#remasterUploadButton');
  var refreshButton = document.querySelector('#remasterRefreshButton');
  var jobsList = document.querySelector('#remasterJobsList');
  var pollTimer = null;
  var loaded = false;

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', Boolean(isError));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async function readJsonResponse(response) {
    var contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return null;
    return response.json().catch(function() { return null; });
  }

  function formatDate(value) {
    if (!value) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function formatStatus(status) {
    status = String(status || '').toLowerCase();
    if (status === 'queued') return 'Queued';
    if (status === 'running') return 'Rendering';
    if (status === 'completed') return 'Completed';
    if (status === 'failed') return 'Failed';
    if (status === 'cancelled') return 'Cancelled';
    if (status === 'superseded') return 'Superseded';
    return status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
  }

  function isLiveJob(job) {
    return job && ['queued', 'running'].includes(String(job.status || '').toLowerCase());
  }

  function resultUrl(job) {
    return '/api/v1/tools/remaster-jobs/' + encodeURIComponent(job.id) + '/result';
  }

  function renderJobs(jobs) {
    if (!jobsList) return;
    if (!Array.isArray(jobs) || !jobs.length) {
      jobsList.innerHTML = '<div class="admin-empty">No remaster jobs yet.</div>';
      schedulePolling(false);
      return;
    }

    jobsList.innerHTML = jobs.map(function(job) {
      var status = String(job.status || '').toLowerCase();
      var queueText = job.queuePosition ? 'Queue #' + job.queuePosition : formatStatus(status);
      var inputExpires = formatDate(job.inputExpiresAt);
      var resultExpires = formatDate(job.resultExpiresAt);
      var canCancel = status === 'queued' || status === 'running';
      var canDownload = job.hasResult && status === 'completed';
      var error = job.lastError
        ? '<div class="tools-job-error">' + escapeHtml(job.lastError) + '</div>'
        : '';
      var download = canDownload
        ? '<a class="btn-primary tools-job-action" href="' + resultUrl(job) + '">Download WAV</a>'
        : '';
      var cancel = canCancel
        ? '<button class="btn-ghost tools-job-action" type="button" data-remaster-cancel="' + escapeHtml(job.id) + '">Cancel</button>'
        : '';
      var retention = resultExpires
        ? '<span>Result expires ' + escapeHtml(resultExpires) + '</span>'
        : inputExpires
          ? '<span>Input expires ' + escapeHtml(inputExpires) + '</span>'
          : '';

      return [
        '<article class="tools-job-card" data-status="' + escapeHtml(status) + '">',
        '  <div class="tools-job-main">',
        '    <div class="tools-job-title">' + escapeHtml(job.inputFilename || job.resultFilename || 'Remaster job') + '</div>',
        '    <div class="tools-job-meta">',
        '      <span>Queued ' + escapeHtml(formatDate(job.queuedAt) || 'recently') + '</span>',
        retention,
        '    </div>',
        error,
        '  </div>',
        '  <div class="tools-job-side">',
        '    <span class="tools-job-status">' + escapeHtml(queueText) + '</span>',
        '    <div class="tools-job-actions">' + download + cancel + '</div>',
        '  </div>',
        '</article>'
      ].join('');
    }).join('');

    schedulePolling(jobs.some(isLiveJob));
  }

  function schedulePolling(shouldPoll) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (shouldPoll) {
      pollTimer = setTimeout(function() {
        loadJobs({ silent: true });
      }, 10000);
    }
  }

  async function loadJobs(options) {
    options = options || {};
    if (!options.silent) setStatus('Loading remaster jobs...');
    try {
      var response = await fetch('/api/v1/tools/remaster-jobs', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      var payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload?.error || 'Could not load remaster jobs.');
      }
      renderJobs(payload || []);
      if (!options.silent) setStatus('');
    } catch (err) {
      setStatus(err.message || 'Could not load remaster jobs.', true);
      if (jobsList) jobsList.innerHTML = '<div class="admin-empty">Could not load remaster jobs.</div>';
      schedulePolling(false);
    }
  }

  async function enqueueRemaster(event) {
    event.preventDefault();
    var file = fileInput?.files?.[0];
    if (!file) {
      setStatus('Choose an MP3 or WAV first.', true);
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setStatus('Audio must be 100MB or less.', true);
      return;
    }

    var body = new FormData();
    body.append('audioFile', file);

    if (submitButton) submitButton.disabled = true;
    setStatus('Queueing remaster...');
    try {
      var response = await fetch('/api/v1/tools/remaster-jobs', {
        method: 'POST',
        credentials: 'include',
        body: body
      });
      var payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload?.error || 'Could not queue remaster.');
      }
      if (fileInput) fileInput.value = '';
      if (fileName) fileName.textContent = 'Choose MP3 or WAV';
      setStatus('Remaster queued.');
      await loadJobs({ silent: true });
    } catch (err) {
      setStatus(err.message || 'Could not queue remaster.', true);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function cancelRemaster(jobId) {
    setStatus('Cancelling remaster...');
    try {
      var response = await fetch('/api/v1/tools/remaster-jobs/' + encodeURIComponent(jobId), {
        method: 'DELETE',
        credentials: 'include'
      });
      var payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload?.error || 'Could not cancel remaster.');
      }
      setStatus('Remaster cancelled.');
      await loadJobs({ silent: true });
    } catch (err) {
      setStatus(err.message || 'Could not cancel remaster.', true);
    }
  }

  function loadAccountTools() {
    loaded = true;
    return loadJobs();
  }

  if (fileInput && fileName) {
    fileInput.addEventListener('change', function() {
      var file = fileInput.files?.[0];
      fileName.textContent = file ? file.name : 'Choose MP3 or WAV';
    });
  }

  if (form) form.addEventListener('submit', enqueueRemaster);
  if (refreshButton) refreshButton.addEventListener('click', function() { loadJobs(); });
  if (jobsList) {
    jobsList.addEventListener('click', function(event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var cancelButton = target.closest('[data-remaster-cancel]');
      if (cancelButton) {
        cancelRemaster(cancelButton.getAttribute('data-remaster-cancel'));
      }
    });
  }

  window.loadAccountTools = loadAccountTools;

  if (!loaded && location.hash.replace('#', '').toLowerCase() === 'tools') {
    loadAccountTools();
  }
})();
