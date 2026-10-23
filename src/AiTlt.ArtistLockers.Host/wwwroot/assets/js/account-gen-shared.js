/* Shared layer of the generation tools (Video Generation, Image Generator) in the account Tools tab.

   Both studios sit on one queue (/api/ed3/h3), so they share one state poll, one chime, one
   reference picker and the same queue-bar and GPU-strip renderers. Each studio keeps its own
   composer, lists and preview; this file only holds what would otherwise be written twice.

   Reference picking is deliberately local to the generation tools rather than an extension of
   MobvisionAssetPicker: that picker resolves a URL, and these tools need an asset id, a kind, and
   a Mine/Shared split. Widening the shared component for one caller would put every page that
   uses it at risk. */
(function () {
  'use strict';

  var API = '/api/v1/tools';
  var BELL_KEY = 'artistlockers.h3.bell';
  var GPU_MODE_KEY = 'artistlockers.h3.gpuMode';
  var LIVE_POLL = 4000;
  var IDLE_POLL = 20000;

  // ── small helpers ───────────────────────────────────────────────────────

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function readJson(response) {
    var type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return null;
    return response.json().catch(function () { return null; });
  }

  async function api(path, options) {
    options = options || {};
    var target = /^\/assets\/[^/]+\/share$/.test(path) ? '/api/v1/library/mine/' + path.split('/')[2] + '/share'
      : path === '/assets' && options.method === 'POST' ? '/api/v1/library/mine' : API + path;
    var response = await fetch(target, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: options.body instanceof FormData
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: options.body instanceof FormData
        ? options.body
        : (options.body ? JSON.stringify(options.body) : undefined)
    });
    var payload = await readJson(response);
    if (!response.ok) {
      throw new Error((payload && (payload.error || payload.message)) || 'The generation service is unavailable.');
    }
    return payload;
  }

  function assetUrl(id) {
    return '/media/' + encodeURIComponent(id);
  }

  // A single frame off the clip, stored on the row. The route 404s for anything that has no
  // frame to give, which is why every caller pairs the <img> with a fallback underneath it.
  function posterUrl(id) {
    return assetUrl(id) + '/poster';
  }

  function formatDuration(seconds) {
    var value = Number(seconds);
    if (!isFinite(value) || value <= 0) return '';
    if (value < 10) return value.toFixed(1) + 's';
    if (value < 60) return Math.round(value) + 's';
    var mins = Math.floor(value / 60);
    var secs = Math.round(value % 60);
    if (secs === 60) { mins += 1; secs = 0; }
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  }

  // "1280×704 · 5.2s", with either half dropped when it was never probed.
  function formatMediaMeta(meta) {
    if (!meta) return '';
    var parts = [];
    if (meta.mediaWidth && meta.mediaHeight) parts.push(meta.mediaWidth + '×' + meta.mediaHeight);
    var duration = formatDuration(meta.durationSeconds);
    if (duration) parts.push(duration);
    return parts.join(' · ');
  }

  // Fills a thumbnail box with the glyph it always had, then lays the poster over the top once
  // it arrives. A 404 or a row uploaded before posters existed simply leaves the glyph.
  function posterInto(container, assetId, glyphText, glyphClass) {
    var mark = node('div', glyphClass, glyphText);
    container.appendChild(mark);
    if (!assetId) return;

    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('load', function () {
      if (mark.parentNode) mark.parentNode.removeChild(mark);
    });
    img.addEventListener('error', function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    });
    img.src = posterUrl(assetId);
    container.appendChild(img);
  }

  var hoverPreview = null;

  // Hover-to-play, one clip at a time. preload="none" keeps browsing a rail of videos free:
  // the bytes are only fetched once a pointer actually rests on a tile.
  function attachHoverPreview(container, assetId) {
    container.addEventListener('mouseenter', function () {
      stopHoverPreview();
      var video = document.createElement('video');
      video.className = 'h3-thumb-video';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'none';
      video.src = assetUrl(assetId);
      container.appendChild(video);
      hoverPreview = video;
      var started = video.play();
      if (started && started.catch) started.catch(function () { /* autoplay refused */ });
    });
    container.addEventListener('mouseleave', stopHoverPreview);
  }

  function stopHoverPreview() {
    if (!hoverPreview) return;
    var video = hoverPreview;
    hoverPreview = null;
    try { video.pause(); } catch (err) { /* already detached */ }
    // Dropped so the connection closes instead of buffering a clip nobody is looking at.
    video.removeAttribute('src');
    if (video.parentNode) video.parentNode.removeChild(video);
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
    return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function fillSelect(select, values, selected) {
    if (!select) return;
    select.innerHTML = (values || []).map(function (value) {
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
    }).join('');
    if (selected) select.value = selected;
  }

  /** A job row's kind; rows from before the model column read as video. */
  function kindOf(job) {
    return (job && job.kind) || 'video';
  }

  function isImage(job) {
    return kindOf(job) === 'image';
  }

  // ── the chime ───────────────────────────────────────────────────────────

  var titleFlashTimer = null;
  var baseTitle = document.title;

  function bellEnabled() {
    try {
      return window.localStorage.getItem(BELL_KEY) !== 'off';
    } catch (err) {
      return true;
    }
  }

  function setBellEnabled(on) {
    try {
      window.localStorage.setItem(BELL_KEY, on ? 'on' : 'off');
    } catch (err) { /* private mode — the toggle just won't persist */ }
    document.querySelectorAll('[data-gen-bell]').forEach(function (bell) {
      bell.setAttribute('aria-pressed', String(on));
    });
  }

  /* A struck bar rather than a beep: inharmonic partials make it read as a bell instead of a
     test tone, and the ear notices it across a room without being shrill. */
  function strike(context, when, root, gain, decay) {
    [1, 2.0, 2.4, 3.0].forEach(function (ratio, index) {
      var osc = context.createOscillator();
      var amp = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = root * ratio;
      var peak = gain / (index + 1.6);
      amp.gain.setValueAtTime(0.0001, when);
      amp.gain.exponentialRampToValueAtTime(peak, when + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);
      osc.connect(amp);
      amp.connect(context.destination);
      osc.start(when);
      osc.stop(when + decay + 0.05);
    });
  }

  function ring(success) {
    if (!bellEnabled()) return;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      var context = new Ctor();
      var now = context.currentTime + 0.02;
      if (success) {
        strike(context, now, 784, 0.18, 1.1);
        strike(context, now + 0.16, 1046, 0.14, 1.4);
      } else {
        strike(context, now, 320, 0.16, 1.6);
      }
      setTimeout(function () { context.close().catch(function () {}); }, 2600);
    } catch (err) { /* autoplay policy or no audio device */ }
  }

  function flashTitle(message) {
    if (!document.hidden) return;
    if (titleFlashTimer) clearInterval(titleFlashTimer);
    var on = false;
    titleFlashTimer = setInterval(function () {
      on = !on;
      document.title = on ? message : baseTitle;
    }, 1200);
  }

  function stopTitleFlash() {
    if (!titleFlashTimer) return;
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
    document.title = baseTitle;
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) stopTitleFlash();
  });

  /** Wires a studio's bell button; every bell on the page mirrors the one setting. */
  function bindBell(button) {
    if (!button) return;
    button.setAttribute('data-gen-bell', '');
    button.setAttribute('aria-pressed', String(bellEnabled()));
    button.addEventListener('click', function () {
      var next = button.getAttribute('aria-pressed') !== 'true';
      setBellEnabled(next);
      if (next) ring(true);
    });
  }

  // ── status wording ──────────────────────────────────────────────────────

  /** Sampler progress as 0..100, or null while ComfyUI has not reported a step yet. */
  function progressPercent(item) {
    if (!item || !(item.progressMax > 0)) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (item.progressValue || 0) / item.progressMax)));
  }

  function statusLabel(job) {
    // A cloud job waits on its provider's own line, never in the GPU queue, and reports no steps.
    var Models = window.MvGenModels;
    if (Models && Models.isCloudJob(job)) {
      var at = ' at ' + Models.providerLabel({ provider: Models.jobProvider(job) });
      if (job.status === 'queued') return 'Waiting' + at;
      if (job.status === 'running') return 'Rendering' + at;
    }
    if (job.status === 'staged') return 'Backlog #' + job.stageOrder;
    if (job.status === 'queued') return job.queuePosition ? 'Queued #' + job.queuePosition : 'Queued';
    if (job.status === 'running') {
      var pct = progressPercent(job);
      var phase = pct === null ? 'Rendering'
        // Past the last sampler step the decode and the encode still run; they have no step count.
        : pct >= 100 ? 'Finishing'
        : 'Rendering ' + pct + '% · step ' + job.progressValue + '/' + job.progressMax;
      return phase + (job.workerLabel ? ' on ' + job.workerLabel : '');
    }
    if (job.status === 'completed') return 'Done';
    if (job.status === 'failed') return 'Failed';
    if (job.status === 'cancelled') return 'Cancelled';
    return job.status;
  }

  /** "1280×704 · 5.2s" for a clip, "1024×1024" for a still. */
  function sizeLabel(job) {
    var size = job.width + '×' + job.height;
    return isImage(job) ? size : size + ' · ' + Number(job.seconds || 0).toFixed(1) + 's';
  }

  // ── the reference picker ────────────────────────────────────────────────
  // One modal for the page. Each open names the rail and the callback that takes the pick, so
  // the studio that opened it is the one that receives the asset.

  var picker = { backdrop: null, grid: null, tabs: null, title: null, note: null, file: null };
  var pickerRail = 'image';
  var pickerSource = 'mine';
  var pickerHandlers = null;

  function buildPicker() {
    if (picker.backdrop) return;

    picker.backdrop = node('div', 'upload-modal-backdrop picker-backdrop');
    var modal = node('div', 'upload-modal picker-modal');

    var header = node('div', 'upload-modal-header');
    picker.title = node('div', 'admin-section-heading', 'Choose a reference');
    header.appendChild(picker.title);

    var close = node('button', 'button-reset upload-modal-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closePicker);
    header.appendChild(close);

    var body = node('div', 'upload-modal-body');
    picker.tabs = node('div', 'h3-picker-tabs');
    ['mine', 'shared'].forEach(function (source) {
      var tab = node('button', 'h3-picker-tab', source === 'mine' ? 'Mine' : 'Shared');
      tab.type = 'button';
      tab.dataset.pickerSource = source;
      tab.addEventListener('click', function () {
        pickerSource = source;
        renderPickerTabs();
        loadPicker();
      });
      picker.tabs.appendChild(tab);
    });

    picker.grid = node('div', 'h3-picker-grid');

    var foot = node('div', 'h3-picker-foot');
    var upload = node('button', 'btn-secondary', '+ Upload');
    upload.type = 'button';
    upload.addEventListener('click', function () { picker.file.click(); });
    picker.file = document.createElement('input');
    picker.file.type = 'file';
    picker.file.hidden = true;
    picker.file.addEventListener('change', uploadFromPicker);
    picker.note = node('span', 'h3-picker-note', '');
    foot.appendChild(upload);
    foot.appendChild(picker.file);
    foot.appendChild(picker.note);

    body.appendChild(picker.tabs);
    body.appendChild(picker.grid);
    body.appendChild(foot);
    modal.appendChild(header);
    modal.appendChild(body);
    picker.backdrop.appendChild(modal);
    document.body.appendChild(picker.backdrop);

    picker.backdrop.addEventListener('click', function (event) {
      if (event.target === picker.backdrop) closePicker();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && picker.backdrop.classList.contains('is-visible')) closePicker();
    });
  }

  function renderPickerTabs() {
    picker.tabs.querySelectorAll('[data-picker-source]').forEach(function (tab) {
      tab.classList.toggle('is-active', tab.dataset.pickerSource === pickerSource);
    });
  }

  function acceptFor(rail) {
    if (rail === 'image') return 'image/png,image/jpeg,image/webp';
    if (rail === 'audio') return 'audio/mpeg,audio/wav,audio/flac,audio/ogg,audio/mp4';
    return 'video/mp4,video/webm';
  }

  /** handlers: { onPick(pick), onUploaded() } — onPick gets the same shape the rails store. */
  function openPicker(rail, handlers) {
    buildPicker();
    pickerRail = rail;
    pickerSource = 'mine';
    pickerHandlers = handlers || {};
    picker.title.textContent = 'Choose ' + (rail === 'audio' ? 'an' : 'a') + ' ' + rail + ' reference';
    picker.file.accept = acceptFor(rail);
    picker.note.textContent = rail === 'image'
      ? 'PNG, JPEG or WebP.'
      : rail === 'audio' ? 'MP3, WAV, FLAC, OGG or M4A.' : 'MP4 or WebM.';
    renderPickerTabs();
    picker.backdrop.classList.add('is-visible');
    loadPicker();
  }

  function closePicker() {
    if (picker.backdrop) picker.backdrop.classList.remove('is-visible');
  }

  function toPick(asset, fallbackName) {
    return {
      id: asset.id,
      filename: asset.filename || fallbackName || '',
      withAudio: false,
      hasPoster: Boolean(asset.hasPoster || asset.posterUrl),
      durationSeconds: asset.durationSeconds,
      mediaWidth: asset.mediaWidth || asset.width,
      mediaHeight: asset.mediaHeight || asset.height
    };
  }

  function deliverPick(pick) {
    closePicker();
    if (pickerHandlers && typeof pickerHandlers.onPick === 'function') pickerHandlers.onPick(pick);
  }

  async function loadPicker() {
    picker.grid.textContent = '';
    picker.grid.appendChild(node('div', 'admin-empty', 'Loading...'));
    try {
      var query = '?kind=' + encodeURIComponent(pickerRail) + '&source=' + encodeURIComponent(pickerSource);
      var offset = 0, all = [];
      async function more() {
        var response = await fetch('/api/v1/library/' + pickerSource + '?kind=' + encodeURIComponent(pickerRail) + '&limit=60&offset=' + offset);
        if (!response.ok) throw new Error('Your references could not be loaded.');
        var page = await response.json();
        all = all.concat(page.items.map(function(a){ return Object.assign({}, a, {hasPoster: !!a.posterUrl, mediaWidth:a.width, mediaHeight:a.height}); }));
        offset += page.items.length; renderPickerGrid(all);
        if (page.hasMore && page.items.length) {
          var next = node('button', 'btn-secondary', 'Load more'); next.type = 'button';
          next.onclick = async function(){next.disabled=true;try{await more();}catch(e){next.textContent=e.message;next.disabled=false;}};
          picker.grid.appendChild(next);
        }
      }
      await more();
    } catch (err) {
      picker.grid.textContent = '';
      picker.grid.appendChild(node('div', 'admin-empty', err.message));
    }
  }

  function renderPickerGrid(assets) {
    picker.grid.textContent = '';
    if (!assets.length) {
      picker.grid.appendChild(node('div', 'admin-empty',
        pickerSource === 'mine' ? 'Nothing uploaded yet.' : 'Nothing shared yet.'));
      return;
    }

    assets.forEach(function (asset) {
      var card = node('button', 'h3-picker-card');
      card.type = 'button';

      var thumb = node('div', 'h3-picker-thumb');
      if (pickerRail === 'image') {
        var img = document.createElement('img');
        img.src = asset.url || assetUrl(asset.id);
        img.alt = asset.filename || '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        // Video always asks for a poster even when the row says it has none: the route grabs
        // the frame on that first request, which backfills everything uploaded before this.
        var wantPoster = pickerRail === 'video' || asset.hasPoster;
        posterInto(thumb, wantPoster ? asset.id : null,
          pickerRail === 'audio' ? '♪' : '▶', 'h3-thumb-glyph');
        if (pickerRail === 'video') attachHoverPreview(thumb, asset.id);
      }
      card.appendChild(thumb);
      card.appendChild(node('div', 'h3-picker-name', asset.filename || 'reference'));

      var cardMeta = formatMediaMeta(asset);
      if (cardMeta) card.appendChild(node('div', 'h3-picker-meta', cardMeta));

      card.addEventListener('click', function () { deliverPick(toPick(asset)); });

      picker.grid.appendChild(card);
    });
  }

  async function uploadFromPicker() {
    var file = picker.file.files && picker.file.files[0];
    if (!file) return;

    var handlers = pickerHandlers || {};
    picker.note.textContent = 'Uploading ' + file.name + '...';
    var body = new FormData();
    body.append('meta', JSON.stringify({ filename: file.name, tags: ['reference'] }));
    body.append('file', file);
    try {
      var asset = await api('/assets', { method: 'POST', body: body });
      picker.file.value = '';
      if (asset && asset.kind !== pickerRail) {
        picker.note.textContent = 'That file is ' + asset.kind + ', not ' + pickerRail + '. It was saved anyway.';
        if (typeof handlers.onUploaded === 'function') await handlers.onUploaded();
        return;
      }
      picker.note.textContent = 'Uploaded.';
      deliverPick(toPick(asset, file.name));
      if (typeof handlers.onUploaded === 'function') await handlers.onUploaded();
    } catch (err) {
      picker.file.value = '';
      picker.note.textContent = err.message;
    }
  }

  // ── queue bar ───────────────────────────────────────────────────────────
  // One view per studio (each has its own bar and detail drawer); the data is the one shared queue.

  function queueView(els) {
    var selectedSegment = null;
    var last = { queue: null, jobs: [] };

    function render(queue, jobs) {
      last.queue = queue;
      last.jobs = jobs || [];
      if (!els.bar) return;
      els.bar.textContent = '';

      var segments = (queue && queue.segments) || [];
      var workerCount = (queue && queue.workerCount) || 0;
      if (els.count) {
        els.count.textContent = segments.length
          ? segments.length + ' in the queue · ' + workerCount + ' GPU' + (workerCount === 1 ? '' : 's')
          : 'Idle · ' + workerCount + ' GPU' + (workerCount === 1 ? '' : 's');
      }

      if (!segments.length) {
        els.bar.appendChild(node('div', 'h3-queue-empty', 'Nothing rendering right now.'));
        if (els.detail) els.detail.hidden = true;
        selectedSegment = null;
        return;
      }

      segments.forEach(function (segment) {
        var seg = node(segment.mine ? 'button' : 'div', 'h3-seg');
        seg.classList.add(segment.mine ? 'is-mine' : 'is-theirs');
        var pct = progressPercent(segment);
        var label = segment.mine
          ? 'Your job — position ' + segment.position
          : 'Position ' + segment.position;
        if (segment.status === 'running') {
          seg.classList.add('is-running');
          if (pct === null) {
            // Nothing from the sampler yet (models loading, references encoding): sweep.
            seg.classList.add('is-indeterminate');
            label += ' · warming up';
          } else {
            var fill = node('span', 'h3-seg-fill');
            fill.style.width = pct + '%';
            seg.appendChild(fill);
            seg.setAttribute('aria-valuemin', '0');
            seg.setAttribute('aria-valuemax', '100');
            seg.setAttribute('aria-valuenow', String(pct));
            label += pct >= 100 ? ' · finishing' : ' · ' + pct + '%';
          }
        }
        if (segment.mine && segment.id === selectedSegment) seg.classList.add('is-selected');
        seg.setAttribute('role', 'listitem');
        seg.setAttribute('aria-label', label);
        seg.title = label;

        if (segment.mine) {
          seg.type = 'button';
          seg.addEventListener('click', function () {
            selectedSegment = selectedSegment === segment.id ? null : segment.id;
            render(last.queue, last.jobs);
          });
        }

        els.bar.appendChild(seg);
      });

      renderDetail();
    }

    function renderDetail() {
      if (!els.detail) return;
      if (!selectedSegment) {
        els.detail.hidden = true;
        els.detail.textContent = '';
        return;
      }

      var job = last.jobs.filter(function (candidate) { return candidate.id === selectedSegment; })[0];
      if (!job) {
        els.detail.hidden = true;
        return;
      }

      // Segments stay anonymous; only the operator's own jobs open, and an image job says so.
      var meta = [statusLabel(job)];
      if (isImage(job)) meta.push('image' + (job.mode ? ' · ' + job.mode : ''));
      meta.push(sizeLabel(job));
      meta.push((job.runFlow === 'fused' ? 'fused · ' : '') + job.sampler + ' / ' + job.scheduler + ' · ' + job.steps + ' steps');
      meta.push('seed ' + job.seed);
      if (job.workerLabel) meta.push(job.workerLabel);

      els.detail.hidden = false;
      els.detail.innerHTML =
        '<div class="h3-detail-prompt">' + escapeHtml(job.prompt) + '</div>' +
        '<div class="h3-detail-meta">' + escapeHtml(meta.join(' · ')) + '</div>';
    }

    return { render: render };
  }

  // ── GPU temperatures ────────────────────────────────────────────────────
  // Junction (hotspot) is the number that throttles, so it is the big one. Edge runs far
  // cooler and would look reassuring when it should not.

  var GPU_WARM_C = 95;
  var GPU_HOT_C = 105;
  var gpuViews = [];

  // The chips have two faces: bars (default) read the zone at a glance, numbers give the
  // exact degrees. The choice is per browser, like the chime.

  function gpuMode() {
    try {
      return window.localStorage.getItem(GPU_MODE_KEY) === 'numbers' ? 'numbers' : 'bars';
    } catch (err) {
      return 'bars';
    }
  }

  function setGpuMode(mode) {
    try {
      window.localStorage.setItem(GPU_MODE_KEY, mode);
    } catch (err) { /* private mode: the toggle just won't persist */ }
    gpuViews.forEach(function (view) { view.rerender(); });
  }

  // Material Design icon paths (Apache 2.0): thermostat, bolt, memory. Drawn with the page's
  // inline-SVG convention (fill: currentColor) so they take the row's colour.
  var GPU_ICONS = {
    temp: 'M15 13V5c0-1.66-1.34-3-3-3S9 3.34 9 5v8c-1.21.91-2 2.37-2 4 0 2.76 2.24 5 5 5s5-2.24 5-5c0-1.63-.79-3.09-2-4zm-4-8c0-.55.45-1 1-1s1 .45 1 1h-1v1h1v2h-1v1h1v2h-2V5z',
    busy: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z',
    vram: 'M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z'
  };

  // One labelled line of a chip: icon, then the bar. The label lands in the tooltip and on the
  // icon for screen readers; the bar itself stays wordless.
  function gpuRow(cls, iconPath, label, bar) {
    var row = node('div', 'h3-gpu-row ' + cls);
    row.title = label;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'h3-gpu-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', iconPath);
    svg.appendChild(path);
    row.appendChild(svg);
    row.appendChild(bar);
    return row;
  }

  // A track with a fill; `ratio` null means unknown and leaves the track empty.
  function gpuBar(cls, ratio) {
    var bar = node('div', cls);
    var fill = node('span', 'h3-gpu-fill');
    fill.style.width = ratio === null ? '0%' : (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
    bar.appendChild(fill);
    return bar;
  }

  function describeAge(seconds) {
    if (seconds < 90) return seconds + ' s';
    if (seconds < 5400) return Math.round(seconds / 60) + ' min';
    return Math.round(seconds / 3600) + ' h';
  }

  /** els: { strip, cards, mode } of one studio's GPU strip. */
  function gpuView(els) {
    var lastView = null;

    function reflectMode() {
      if (!els.mode) return;
      var mode = gpuMode();
      Array.prototype.forEach.call(els.mode.querySelectorAll('[data-gpu-mode]'), function (tab) {
        tab.setAttribute('aria-pressed', String(tab.getAttribute('data-gpu-mode') === mode));
      });
    }

    function render(view) {
      lastView = view;
      if (!els.strip || !els.cards) return;
      var cards = (view && view.gpus) || [];
      els.cards.textContent = '';
      if (!cards.length) {
        els.strip.hidden = true;
        return;
      }
      els.strip.hidden = false;

      var stale = Boolean(view.stale);
      var numbers = gpuMode() === 'numbers';
      els.cards.classList.toggle('is-numbers', numbers);

      cards.forEach(function (card) {
        var chip = node('div', 'h3-gpu');
        chip.setAttribute('role', 'listitem');
        if (card.role === 'llm') chip.classList.add('is-llm');
        if (stale) chip.classList.add('is-stale');

        var junction = typeof card.junctionC === 'number' ? Math.round(card.junctionC) : null;
        var limit = typeof card.junctionLimitC === 'number' ? Math.round(card.junctionLimitC) : null;
        var busy = !stale && typeof card.busyPercent === 'number' ? Math.round(card.busyPercent) : null;
        var vram = !stale && typeof card.vramUsedMb === 'number' && typeof card.vramTotalMb === 'number' && card.vramTotalMb > 0
          ? { used: card.vramUsedMb, total: card.vramTotalMb } : null;
        if (!stale && junction !== null) {
          if (junction >= GPU_HOT_C || card.throttling) chip.classList.add('is-hot');
          else if (junction >= GPU_WARM_C) chip.classList.add('is-warm');
        }

        var head = node('div', 'h3-gpu-head');
        head.appendChild(node('span', 'h3-gpu-label', card.label || card.renderNode || 'GPU'));
        if (card.role === 'llm') head.appendChild(node('span', 'h3-gpu-role', 'prompt LLM'));
        chip.appendChild(head);

        if (numbers) {
          var temp = node('div', 'h3-gpu-temp');
          temp.appendChild(node('span', 'h3-gpu-degrees', stale || junction === null ? '—' : junction + '°'));
          if (!stale && limit !== null) temp.appendChild(node('span', 'h3-gpu-limit', '/ ' + limit + '°'));
          chip.appendChild(temp);

          var facts = [];
          if (busy !== null) facts.push(busy + '% busy');
          if (vram) facts.push((vram.used / 1024).toFixed(1) + ' / ' + Math.round(vram.total / 1024) + ' GB');
          if (facts.length) chip.appendChild(node('div', 'h3-gpu-facts', facts.join(' · ')));
        } else {
          // Temperature bar: fill = junction over its limit, ticks at the amber and red lines so
          // the zone reads without a number.
          var scale = limit || 110;
          var tempBar = gpuBar('h3-gpu-bar is-temp', stale || junction === null ? null : junction / scale);
          [GPU_WARM_C, GPU_HOT_C].forEach(function (mark) {
            var tick = node('i', 'h3-gpu-tick');
            tick.style.left = Math.min(100, (mark / scale) * 100).toFixed(1) + '%';
            tempBar.appendChild(tick);
          });
          chip.appendChild(gpuRow('is-temp', GPU_ICONS.temp, 'Junction temperature', tempBar));
          chip.appendChild(gpuRow('is-busy', GPU_ICONS.busy, 'Busy', gpuBar('h3-gpu-bar is-busy', busy === null ? null : busy / 100)));
          chip.appendChild(gpuRow('is-vram', GPU_ICONS.vram, 'VRAM in use', gpuBar('h3-gpu-bar is-vram', vram ? vram.used / vram.total : null)));
        }

        var note = null;
        if (stale) {
          note = typeof view.ageSeconds === 'number' ? 'no reading for ' + describeAge(view.ageSeconds) : 'no reading yet';
        } else if (card.throttling) {
          note = 'throttling';
        } else if (card.perfLevel && card.perfLevel !== 'high') {
          note = 'clocks down (' + card.perfLevel + ')';
        }
        if (note) chip.appendChild(node('div', 'h3-gpu-note', note));

        var title = [(card.label || card.renderNode || 'GPU') + ' · ' + (card.renderNode || '') + ' ' + (card.pci || '')];
        if (!stale && junction !== null) title.push('junction ' + junction + '°' + (limit !== null ? ' / ' + limit + '°' : ''));
        if (busy !== null) title.push(busy + '% busy');
        if (vram) title.push((vram.used / 1024).toFixed(1) + ' / ' + Math.round(vram.total / 1024) + ' GB VRAM');
        if (!stale && typeof card.powerW === 'number') title.push(Math.round(card.powerW) + ' W');
        chip.title = title.join('\n').trim();
        els.cards.appendChild(chip);
      });
    }

    if (els.mode) {
      reflectMode();
      els.mode.addEventListener('click', function (event) {
        var tab = event.target.closest('[data-gpu-mode]');
        if (tab) setGpuMode(tab.getAttribute('data-gpu-mode'));
      });
    }

    var view = {
      render: render,
      rerender: function () { reflectMode(); render(lastView); }
    };
    gpuViews.push(view);
    return view;
  }

  // ── the shared state poll ───────────────────────────────────────────────
  // One /state poll for the page, however many studios are open. Subscribers get the fresh
  // state plus the jobs that finished since the previous poll; the chime rings once for all.

  var state = { queue: null, jobs: [], shelf: [], gpus: null };
  var subscribers = [];
  var pollTimer = null;
  var previousStatuses = {};
  var inFlightRefresh = null;

  function subscribe(fn) {
    subscribers.push(fn);
  }

  function finishedSince(jobs, shelf) {
    var byId = {};
    var rows = {};
    shelf.concat(jobs).forEach(function (job) { byId[job.id] = job.status; rows[job.id] = job; });

    var finished = [];
    Object.keys(previousStatuses).forEach(function (id) {
      var before = previousStatuses[id];
      var after = byId[id];
      if (!after || before === after) return;
      if (before !== 'running' && before !== 'queued') return;
      if (after === 'completed' || after === 'failed') finished.push(rows[id]);
    });

    previousStatuses = byId;
    return finished;
  }

  function announce(finished) {
    var succeeded = finished.filter(function (job) { return job.status === 'completed'; }).length;
    var failed = finished.length - succeeded;
    if (succeeded) {
      ring(true);
      flashTitle('✅ Render ready');
    } else if (failed) {
      ring(false);
      flashTitle('⚠ Render failed');
    }
  }

  function schedulePoll(delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { refresh(); }, delay);
  }

  function hasLiveWork() {
    return state.jobs.some(function (job) {
      return job.status === 'staged' || job.status === 'queued' || job.status === 'running';
    }) || Boolean(state.queue && state.queue.segments && state.queue.segments.length);
  }

  /** Re-reads /state and notifies every studio. Concurrent callers share one request. */
  function refresh() {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = (async function () {
      try {
        var payload = await api('/state');
        state.queue = payload.queue;
        state.jobs = payload.jobs || [];
        state.shelf = payload.shelf || [];
        state.gpus = payload.gpus || null;

        var finished = finishedSince(state.jobs, state.shelf);
        announce(finished);
        subscribers.forEach(function (fn) { fn(state, { finished: finished }); });
        schedulePoll(hasLiveWork() ? LIVE_POLL : IDLE_POLL);
      } catch (err) {
        subscribers.forEach(function (fn) { fn(state, { error: err }); });
        schedulePoll(IDLE_POLL);
      } finally {
        inFlightRefresh = null;
      }
    })();
    return inFlightRefresh;
  }

  var limitsPromise = null;

  /** /limits, shared; pass force to re-read after something changed the numbers (an upload). */
  function loadLimits(force) {
    if (!limitsPromise || force) {
      limitsPromise = api('/limits').catch(function (err) {
        limitsPromise = null;
        throw err;
      });
    }
    return limitsPromise;
  }

  // ── the role gate ───────────────────────────────────────────────────────

  var rolesPromise = null;

  function resolveRoles() {
    if (rolesPromise) return rolesPromise;
    rolesPromise = (async function () {
      try {
        var response = await fetch('/api/v1/me', { credentials: 'include' });
        return response.ok && (await response.json()).canGenerate === true;
      } catch { return false; }
    })();
    return rolesPromise;
  }

  /** Runs start() when the Tools tab first opens, chaining onto whatever loader was there. */
  function onToolsOpen(start) {
    var previousLoader = window.loadAccountTools;
    window.loadAccountTools = function () {
      var result = typeof previousLoader === 'function' ? previousLoader() : undefined;
      start();
      return result;
    };
    if (document.querySelector('#panelTools.is-visible')) start();
  }

  // Each studio registers how it loads a finished job into its composer once it has started, so
  // the gallery's Repeat can hand a generation back without knowing the studio's fields.
  var composers = {};
  var composerWaiters = {};

  function provideComposer(kind, load) {
    composers[kind] = load;
    (composerWaiters[kind] || []).forEach(function (resolve) { resolve(load); });
    composerWaiters[kind] = [];
  }

  /** Resolves with the studio's loader for 'video' or 'image', or null if it has not started within timeoutMs. */
  function whenComposer(kind, timeoutMs) {
    if (composers[kind]) return Promise.resolve(composers[kind]);
    return new Promise(function (resolve) {
      (composerWaiters[kind] = composerWaiters[kind] || []).push(resolve);
      setTimeout(function () { resolve(composers[kind] || null); }, timeoutMs || 8000);
    });
  }

  // ── frame tool ──────────────────────────────────────────────────────────
  // Sits under a finished clip: a coarse slider across the whole clip and a fine one of ±60
  // frames around it pick one frame, the video seeks to it as either moves, and the server cuts
  // that exact frame out of the file. The browser's own frame is only ever a preview.

  var FINE_SPAN = 60;
  // Extend replaces the previous continuation frame and keeps every other picture; the server
  // names saved frames frame-<video>-f<n>.png, which is how they are told apart.
  var FRAME_PREFIX = /^frame-/i;

  async function accountAssetsApi(path, options) {
    options = options || {};
    var response = await fetch('/api/v1/library/mine/' + path, {
      method: options.method || 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    var payload = await readJson(response);
    if (!response.ok) {
      throw new Error((payload && (payload.error || payload.detail)) || 'The frame service is unavailable.');
    }
    return payload;
  }

  /**
   * Builds the frame tool for a video element. opts: video, assetId, onSaved(asset, created),
   * onExtend(frameAsset) — Extend only shows when onExtend is given. Starts on the last frame.
   * onExtendPlus(frame) — Extend+ (the render continues the clip itself, from its closing frames);
   * shows when given, and extendPlusBlocked, when a non-empty string (or a promise of one), disables it
   * with that reason.
   */
  function frameTool(opts) {
    var video = opts.video;
    var info = null;
    var base = 0;
    var fine = 0;
    var busy = false;
    var lastOwnSeek = 0;

    var root = node('div', 'gen-frames');
    var head = node('div', 'gen-frames-head');
    head.appendChild(node('span', 'gen-frames-label', 'Frame'));
    var readout = node('span', 'gen-frames-readout', 'Reading frames…');
    head.appendChild(readout);
    root.appendChild(head);

    var coarse = node('input', 'gen-frames-coarse');
    coarse.type = 'range';
    coarse.min = '0';
    coarse.max = '0';
    coarse.step = '1';
    coarse.setAttribute('aria-label', 'Position in the clip');
    root.appendChild(coarse);

    var fineRow = node('div', 'gen-frames-fine');
    var prev = node('button', 'btn-ghost gen-frames-step', '◀');
    prev.type = 'button';
    prev.title = 'One frame back';
    var fineInput = node('input', 'gen-frames-fine-range');
    fineInput.type = 'range';
    fineInput.min = String(-FINE_SPAN);
    fineInput.max = String(FINE_SPAN);
    fineInput.step = '1';
    fineInput.value = '0';
    fineInput.setAttribute('aria-label', 'Fine adjust, up to 60 frames either way');
    var next = node('button', 'btn-ghost gen-frames-step', '▶');
    next.type = 'button';
    next.title = 'One frame forward';
    fineRow.appendChild(prev);
    fineRow.appendChild(fineInput);
    fineRow.appendChild(next);
    root.appendChild(fineRow);

    var actions = node('div', 'gen-frames-actions');
    var save = node('button', 'btn-secondary', 'Save to gallery');
    save.type = 'button';
    save.title = 'Save this exact frame to your gallery as a full-resolution PNG';
    actions.appendChild(save);
    var extend = null;
    if (typeof opts.onExtend === 'function') {
      extend = node('button', 'btn-primary', 'Extend');
      extend.type = 'button';
      extend.title = 'Continue the clip from this frame: saves it and loads the composer for the next scene';
      actions.appendChild(extend);
    }
    var extendPlus = null;
    var plusBlocked = '';
    var PLUS_TITLE = 'Continue from this frame with the moments leading up to it, picture and sound; ' +
      'the new take holds only what comes next';
    function blockPlus(reason) {
      plusBlocked = reason || '';
      if (!extendPlus) return;
      extendPlus.title = plusBlocked || PLUS_TITLE;
      extendPlus.disabled = busy || !info || Boolean(plusBlocked);
    }
    if (typeof opts.onExtendPlus === 'function') {
      extendPlus = node('button', 'btn-secondary', 'Extend+');
      extendPlus.type = 'button';
      actions.appendChild(extendPlus);
      var blocked = opts.extendPlusBlocked;
      if (blocked && typeof blocked.then === 'function') {
        blockPlus('Checking the render workers…');
        blocked.then(blockPlus, function () { blockPlus(''); });
      } else {
        blockPlus(blocked);
      }
    }
    var status = node('span', 'account-status gen-frames-status');
    status.setAttribute('role', 'status');
    actions.appendChild(status);
    root.appendChild(actions);

    function setStatus(message, isError) {
      status.textContent = message || '';
      status.classList.toggle('is-error', Boolean(isError));
    }

    function lastFrame() { return info ? info.lastFrame : 0; }

    function current() {
      return Math.max(0, Math.min(lastFrame(), base + fine));
    }

    function setEnabled(enabled) {
      [coarse, fineInput, prev, next, save, extend].forEach(function (control) {
        if (control) control.disabled = !enabled;
      });
      if (extendPlus) extendPlus.disabled = !enabled || Boolean(plusBlocked);
    }

    function renderReadout() {
      if (!info) return;
      var frame = current();
      var last = lastFrame();
      var parts = ['frame ' + frame + ' / ' + last, (frame / info.fps).toFixed(2) + ' s'];
      if (last > 0) parts.push(Math.round(frame / last * 100) + '%');
      if (frame === last) parts.push('last');
      else if (frame === 0) parts.push('first');
      readout.textContent = parts.join(' · ');
      coarse.value = String(base);
      fineInput.value = String(fine);
      prev.disabled = busy || frame <= 0;
      next.disabled = busy || frame >= last;
    }

    // The middle of the frame's interval, so rounding in the decoder cannot land on a neighbour.
    function seek() {
      if (!info || !video) return;
      var time = (current() + 0.5) / info.fps;
      if (isFinite(video.duration) && video.duration > 0) time = Math.min(time, Math.max(0, video.duration - 0.001));
      lastOwnSeek = Date.now();
      try {
        if (!video.paused) video.pause();
        video.currentTime = time;
      } catch (err) { /* not seekable yet; loadedmetadata seeks again */ }
    }

    function select(nextBase, nextFine) {
      base = Math.max(0, Math.min(lastFrame(), nextBase));
      fine = Math.max(-FINE_SPAN, Math.min(FINE_SPAN, nextFine));
      renderReadout();
      seek();
    }

    function step(delta) {
      var target = current() + delta;
      if (target < 0 || target > lastFrame()) return;
      // Past the fine slider's reach the coarse one moves instead, so stepping never stalls.
      if (Math.abs(fine + delta) > FINE_SPAN) select(target, 0);
      else select(base, fine + delta);
    }

    coarse.addEventListener('input', function () { select(Number(coarse.value), 0); });
    fineInput.addEventListener('input', function () { select(base, Number(fineInput.value)); });
    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });

    // Scrubbing or pausing the player itself moves the selection to the playhead.
    function followPlayhead() {
      if (!info || busy || Date.now() - lastOwnSeek < 400) return;
      var frame = Math.max(0, Math.min(lastFrame(), Math.floor(video.currentTime * info.fps + 1e-6)));
      if (frame === current()) return;
      base = frame;
      fine = 0;
      renderReadout();
    }
    if (video) {
      video.addEventListener('seeked', followPlayhead);
      video.addEventListener('pause', followPlayhead);
      video.addEventListener('loadedmetadata', function () { if (info) seek(); });
    }

    async function saveFrame() {
      var result = await accountAssetsApi(encodeURIComponent(opts.assetId) + '/frames', {
        method: 'POST', body: { frame: current() }
      });
      if (typeof opts.onSaved === 'function') opts.onSaved(result.item, result.created);
      return result;
    }

    async function run(work) {
      if (busy || !info) return;
      busy = true;
      setEnabled(false);
      try {
        await work();
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        busy = false;
        setEnabled(true);
        renderReadout();
      }
    }

    save.addEventListener('click', function () {
      run(async function () {
        setStatus('Saving frame ' + current() + '…');
        var result = await saveFrame();
        setStatus((result.created ? 'Saved to your gallery as ' : 'Already in your gallery as ') + result.item.filename + '.');
      });
    });

    if (extend) {
      extend.addEventListener('click', function () {
        run(async function () {
          setStatus('Saving frame ' + current() + '…');
          var result = await saveFrame();
          setStatus('Summarising the scene…');
          await opts.onExtend(result.item);
          setStatus('');
        });
      });
    }

    if (extendPlus) {
      extendPlus.addEventListener('click', function () {
        run(async function () {
          setStatus('');
          await opts.onExtendPlus(current());
        });
      });
    }

    setEnabled(false);
    accountAssetsApi(encodeURIComponent(opts.assetId) + '/frames').then(function (frames) {
      if (!frames || !(frames.fps > 0) || !(frames.frameCount > 0)) throw new Error('Frames unavailable.');
      info = frames;
      coarse.max = String(frames.lastFrame);
      setEnabled(true);
      select(frames.lastFrame, 0);
    }).catch(function (err) {
      readout.textContent = 'Frames unavailable';
      setStatus(err.message, true);
    });

    return root;
  }

  /** The director model's short account of a clip, for Extend's idea box; '' when it cannot be had. */
  async function summarizeScene(videoAssetId) {
    try {
      var result = await api('/prompt/summarize', { method: 'POST', body: { assetId: videoAssetId } });
      return (result && result.summary) || '';
    } catch (err) {
      return '';
    }
  }

  function isContinuationFrame(pick) {
    return FRAME_PREFIX.test((pick && pick.filename) || '');
  }

  /** Extend's idea text; the cursor goes at the end, after "Next scene: ". */
  function continuationIdea(summary, pictureTag, isLastFrame) {
    var text = '';
    if (summary) text += 'Previous scene: ' + summary.replace(/\s+$/, '').replace(/([^.!?])$/, '$1.') + '\n';
    text += 'Continue exactly from ' + pictureTag + ' ('
      + (isLastFrame ? 'last frame of the previous clip' : 'the chosen frame of the previous clip')
      + '), same continuous action.\nNext scene: ';
    return text;
  }

  /** Extend+'s idea text: the render sees the clip's closing moments itself, so no picture is named. */
  function extendPlusIdea(summary) {
    var text = '';
    if (summary) text += 'Previous scene: ' + summary.replace(/\s+$/, '').replace(/([^.!?])$/, '$1.') + '\n';
    return text + 'The shot carries straight on from the previous clip, same continuous action and sound.\nNext scene: ';
  }

  /** Why Extend+ cannot run right now, from the queue limits; '' when it can. */
  function extendPlusBlocked(limits) {
    return limits && limits.continuationWorkers > 0 ? '' : 'No render worker is set up for Extend+ right now.';
  }

  /** One line on where an Extend+ take came from (the job's continuation record). */
  function describeExtendPlus(c) {
    return 'Continues ' + (c.sourceFilename || 'a clip') + ' from frame ' + c.frame + ': ' + c.contextFrames +
      ' frames leading up to it guided the start' + (c.withAudio ? ', picture and sound' : ' (the clip has no sound)') +
      ', and the take keeps the ' + c.deliveredFrames + ' new frames after them.';
  }

  window.MvGen = {
    frameTool: frameTool,
    extendPlusBlocked: extendPlusBlocked,
    describeExtendPlus: describeExtendPlus,
    extendPlusIdea: extendPlusIdea,
    summarizeScene: summarizeScene,
    isContinuationFrame: isContinuationFrame,
    continuationIdea: continuationIdea,
    api: api,
    escapeHtml: escapeHtml,
    node: node,
    assetUrl: assetUrl,
    formatDuration: formatDuration,
    formatMediaMeta: formatMediaMeta,
    posterInto: posterInto,
    attachHoverPreview: attachHoverPreview,
    formatBytes: formatBytes,
    fillSelect: fillSelect,
    kindOf: kindOf,
    isImage: isImage,
    bindBell: bindBell,
    progressPercent: progressPercent,
    statusLabel: statusLabel,
    sizeLabel: sizeLabel,
    openPicker: openPicker,
    queueView: queueView,
    gpuView: gpuView,
    subscribe: subscribe,
    refresh: refresh,
    state: state,
    loadLimits: loadLimits,
    resolveRoles: resolveRoles,
    onToolsOpen: onToolsOpen,
    provideComposer: provideComposer,
    whenComposer: whenComposer
  };
})();
