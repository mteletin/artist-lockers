/* Video Generation studio, inside the account Tools tab: MiniMax H3 reference-to-video on our GPUs, and
   the Seevio cloud models (Seedance) for users who saved their own key in the AI zone. The model picker
   reshapes the composer from the model's spec (gen-models.js): a cloud model takes whole seconds, an
   aspect and a resolution, and none of the GPU knobs. Its jobs never enter the GPU queue bar.

   The queue bar shows the whole shared queue but only ever names the operator's own jobs;
   somebody else's segment carries a position and nothing more. The queue is shared with the
   Image Generator, so the bar counts every job while this studio's own lists keep to video.
   Finished work leaves the bar and lands on the results shelf, where it keeps a "new" badge
   until it has been looked at.

   Helpers, the chime, the reference picker, the queue bar, the GPU strip and the state poll
   live in account-gen-shared.js (window.MvGen), which both studios use. */
(function () {
  'use strict';

  var studio = document.querySelector('#h3Studio');
  var Gen = window.MvGen;
  var Models = window.MvGenModels;
  if (!studio || !Gen || !Models) return;

  var RAILS = ['image', 'audio', 'video'];

  var limits = null;
  // Extend+: { sourceAssetId, frame, filename } while the composer continues a clip, else null.
  var continuation = null;
  var state = Gen.state;
  var picks = { image: [], audio: [], video: [] };
  var started = false;
  var previewJobId = null;

  var el = {
    status: document.querySelector('#h3Status'),
    bell: document.querySelector('#h3BellToggle'),
    model: document.querySelector('#h3Model'),
    cloudNote: document.querySelector('#h3CloudNote'),
    contNote: document.querySelector('#h3ContNote'),
    contText: document.querySelector('#h3ContText'),
    contClear: document.querySelector('#h3ContClear'),
    resolutionField: document.querySelector('#h3ResolutionField'),
    resolution: document.querySelector('#h3Resolution'),
    seedField: document.querySelector('#h3SeedField'),
    advanced: document.querySelector('#h3Advanced'),
    queueBar: document.querySelector('#h3QueueBar'),
    queueCount: document.querySelector('#h3QueueCount'),
    queueDetail: document.querySelector('#h3QueueDetail'),
    gpuStrip: document.querySelector('#h3GpuStrip'),
    gpuCards: document.querySelector('#h3GpuCards'),
    gpuMode: document.querySelector('#h3GpuMode'),
    form: document.querySelector('#h3Form'),
    idea: document.querySelector('#h3Idea'),
    advise: document.querySelector('#h3Advise'),
    adviseStatus: document.querySelector('#h3AdviseStatus'),
    prompt: document.querySelector('#h3Prompt'),
    promptCount: document.querySelector('#h3PromptCount'),
    rails: document.querySelector('#h3Rails'),
    length: document.querySelector('#h3Length'),
    lengthOut: document.querySelector('#h3LengthOut'),
    size: document.querySelector('#h3Size'),
    pixelOut: document.querySelector('#h3PixelOut'),
    sampler: document.querySelector('#h3Sampler'),
    scheduler: document.querySelector('#h3Scheduler'),
    steps: document.querySelector('#h3Steps'),
    seed: document.querySelector('#h3Seed'),
    flow: document.querySelector('#h3Flow'),
    refSizeField: document.querySelector('#h3RefSizeField'),
    refImageSize: document.querySelector('#h3RefImageSize'),
    width: document.querySelector('#h3Width'),
    height: document.querySelector('#h3Height'),
    submit: document.querySelector('#h3Submit'),
    slots: document.querySelector('#h3Slots'),
    previewTitle: document.querySelector('#h3PreviewTitle'),
    previewStage: document.querySelector('#h3PreviewStage'),
    previewActions: document.querySelector('#h3PreviewActions'),
    previewFrames: document.querySelector('#h3PreviewFrames'),
    previewDownload: document.querySelector('#h3PreviewDownload'),
    previewShare: document.querySelector('#h3PreviewShare'),
    jobsList: document.querySelector('#h3JobsList'),
    mineHint: document.querySelector('#h3MineHint'),
    shelf: document.querySelector('#h3Shelf'),
    clearNew: document.querySelector('#h3ClearNew')
  };

  // ── small helpers ───────────────────────────────────────────────────────

  var escapeHtml = Gen.escapeHtml;
  var node = Gen.node;
  var api = Gen.api;
  var assetUrl = Gen.assetUrl;
  var formatDuration = Gen.formatDuration;
  var posterInto = Gen.posterInto;
  var attachHoverPreview = Gen.attachHoverPreview;
  var formatBytes = Gen.formatBytes;
  var fillSelect = Gen.fillSelect;
  var statusLabel = Gen.statusLabel;

  function setStatus(message, isError) {
    if (!el.status) return;
    el.status.textContent = message || '';
    el.status.classList.toggle('is-error', Boolean(isError));
  }

  function setAdviseStatus(message, isError) {
    if (!el.adviseStatus) return;
    el.adviseStatus.textContent = message || '';
    el.adviseStatus.classList.toggle('is-error', Boolean(isError));
  }

  /** The picked model's row from /limits; MiniMax H3 when the backend sent none. */
  function currentModel() {
    var model = el.model && Models.find(limits, el.model.value);
    return model || {
      id: Models.H3, kind: 'video', label: 'MiniMax H3', provider: 'local', advisor: 'h3-r2v', supportsSeed: true
    };
  }

  function isCloud() {
    return Models.isCloud(currentModel());
  }

  function tagFor(rail, slot) {
    return Models.tagFor(currentModel(), rail, slot);
  }

  function maxFor(rail) {
    if (!limits) return 0;
    if (isCloud()) return Models.maxFor(currentModel(), rail);
    return rail === 'image' ? limits.maxImages : rail === 'video' ? limits.maxVideos : limits.maxAudios;
  }

  /** This studio's jobs: video only, since the queue also carries Image Generator jobs. */
  function ownKind(jobs) {
    return (jobs || []).filter(function (job) { return !Gen.isImage(job); });
  }

  /** The video models the backend offers. Cloud ones are listed only for users with a key, so a
      picker with H3 alone stays locked. H3 is the default; a still-offered pick survives a refill. */
  function fillModels() {
    if (!el.model) return;
    var previous = el.model.value;
    var models = Models.list(limits, 'video');
    if (!models.length && limits.canGenerateLocal !== false) models = [{ id: Models.H3, label: 'MiniMax H3', provider: 'local' }];
    if (!models.length) {
      el.model.innerHTML = '<option value="">Add your API key in AI zone</option>';
      el.model.disabled = true;
      if (el.submit) el.submit.disabled = true;
      setStatus('Add your own provider key in AI zone to use Video Generator.');
      return;
    }
    if (el.submit) el.submit.disabled = false;
    el.model.innerHTML = models.map(function (model) {
      var label = model.label + (Models.isCloud(model) ? ' · at ' + Models.providerLabel(model) : '');
      return '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    var keep = models.some(function (model) { return model.id === previous; });
    var fallback = models.some(function (model) { return model.id === Models.H3; }) ? Models.H3 : models[0].id;
    el.model.value = keep ? previous : fallback;
    el.model.disabled = models.length < 2;
  }

  /** Shapes the composer for the picked model, keeping what still fits when switching between cloud models. */
  function applyModel() {
    if (!limits) return;
    if (limits.canGenerateLocal === false && !Models.list(limits, 'video').length) return;
    var model = currentModel();
    var cloud = Models.isCloud(model);
    var wasCloud = studio.classList.contains('is-cloud');
    var keep = cloud && wasCloud
      ? { aspect: el.size && el.size.value, resolution: el.resolution && el.resolution.value, seconds: el.length && el.length.value }
      : null;

    studio.classList.toggle('is-cloud', cloud);
    // Extend+ is an H3 render on our GPUs; a cloud model is an ordinary job.
    if (cloud && continuation) setContinuation(null);
    if (el.resolutionField) el.resolutionField.hidden = !cloud;
    if (el.seedField) el.seedField.hidden = model.supportsSeed === false;
    // A cloud model has nothing left under Advanced but its seed.
    if (el.advanced) el.advanced.hidden = cloud && model.supportsSeed === false;
    if (el.refSizeField) el.refSizeField.hidden = cloud || !limits.allowRefImageSizeMax;
    if (el.cloudNote) {
      el.cloudNote.hidden = !cloud;
      el.cloudNote.textContent = cloud
        ? 'Rendered at ' + Models.providerLabel(model) + ' with your own key and billed to your account there, ' +
          'not on our GPUs. ' + model.minSeconds + '–' + model.maxSeconds + ' s, up to ' +
          [[model.maxImages, ' images'], [model.maxVideos, ' videos'], [model.maxAudios, ' audio clips']]
            .filter(function (r) { return r[0] > 0; }).map(function (r) { return r[0] + r[1]; }).join(', ') + '.' +
          (model.audioNeedsVisual ? ' Audio needs an image or a video beside it.' : '')
        : '';
    }
    if (el.submit) el.submit.textContent = cloud ? 'Send to ' + Models.providerLabel(model) : 'Queue render';

    buildSizeOptions(keep);
    buildLengthSlider(keep);
    trimPicks();
    renderRails();
    updateSlotsHint();
  }

  /** A model with fewer slots drops the references past its maximum, and says so. */
  function trimPicks() {
    var dropped = 0;
    RAILS.forEach(function (rail) {
      var max = maxFor(rail);
      if (picks[rail].length > max) {
        dropped += picks[rail].length - max;
        picks[rail].length = max;
      }
    });
    if (dropped) setStatus(dropped + ' reference' + (dropped === 1 ? '' : 's') + ' removed: this model takes fewer.', true);
  }

  // ── controls ────────────────────────────────────────────────────────────

  function snapDimension(value) {
    var snapped = Math.round(Number(value) / 32) * 32;
    return Math.min(2048, Math.max(256, snapped || 256));
  }

  /* Largest pair on the 32-pixel grid that honours the ratio and stays inside the pixel budget.
     720 is not a legal height, which is why a "720p" preset lands on 1280x704. */
  function fitRatio(ratioW, ratioH, maxPixels) {
    var scale = Math.sqrt(maxPixels / (ratioW * ratioH));
    var width = Math.floor((ratioW * scale) / 32) * 32;
    var height = Math.floor((ratioH * scale) / 32) * 32;
    while (width * height > maxPixels && (width > 256 || height > 256)) {
      if (width >= height) width -= 32; else height -= 32;
    }
    return { width: Math.max(width, 256), height: Math.max(height, 256) };
  }

  /** A cloud model's size is an aspect and a resolution; the frame size follows from them. */
  function buildCloudSize(keep) {
    var model = currentModel();
    var aspects = Models.aspects(model);
    el.size.innerHTML = aspects.map(function (a) {
      return '<option value="' + escapeHtml(a.name) + '">' + escapeHtml(a.label) + '</option>';
    }).join('');
    el.size.value = keep && aspects.some(function (a) { return a.name === keep.aspect; }) ? keep.aspect : '16:9';
    if (el.resolution) {
      el.resolution.innerHTML = (model.resolutions || []).map(function (r) {
        return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>';
      }).join('');
      el.resolution.value = Models.pickResolution(model, keep && keep.resolution);
    }
    updatePixelOut();
  }

  function cloudSize() {
    return Models.sizeFor(el.size ? el.size.value : '16:9',
      Models.pickResolution(currentModel(), el.resolution && el.resolution.value));
  }

  function buildSizeOptions(keep) {
    if (!el.size || !limits) return;
    if (isCloud()) {
      buildCloudSize(keep);
      return;
    }
    var ratios = [
      { label: 'Landscape 16:9', w: 16, h: 9 },
      { label: 'Portrait 9:16', w: 9, h: 16 },
      { label: 'Square 1:1', w: 1, h: 1 },
      { label: 'Classic 4:3', w: 4, h: 3 },
      { label: 'Wide 21:9', w: 21, h: 9 }
    ];
    var seen = {};
    var options = [];

    ratios.forEach(function (ratio) {
      // Full budget, plus a draft tier at roughly half the pixels for quick iteration.
      [limits.maxPixels, Math.round(limits.maxPixels * 0.45)].forEach(function (budget, index) {
        var fit = fitRatio(ratio.w, ratio.h, budget);
        var key = fit.width + 'x' + fit.height;
        if (seen[key]) return;
        seen[key] = true;
        options.push({
          key: key,
          width: fit.width,
          height: fit.height,
          label: ratio.label + ' — ' + key + (index ? ' (draft)' : '')
        });
      });
    });

    var defaultKey = limits.defaultWidth + 'x' + limits.defaultHeight;
    if (!seen[defaultKey]) {
      options.unshift({
        key: defaultKey,
        width: limits.defaultWidth,
        height: limits.defaultHeight,
        label: 'Default — ' + defaultKey
      });
    }

    el.size.innerHTML = options.map(function (option) {
      return '<option value="' + escapeHtml(option.key) + '">' + escapeHtml(option.label) + '</option>';
    }).join('') + '<option value="custom">Custom</option>';

    el.size.value = defaultKey;
    applySize(limits.defaultWidth, limits.defaultHeight);
  }

  function applySize(width, height) {
    if (el.width) el.width.value = width;
    if (el.height) el.height.value = height;
    updatePixelOut();
  }

  function currentSize() {
    if (isCloud()) return cloudSize();
    return {
      width: snapDimension(el.width && el.width.value),
      height: snapDimension(el.height && el.height.value)
    };
  }

  function updatePixelOut() {
    if (!el.pixelOut || !limits) return;
    var size = currentSize();
    if (isCloud()) {
      el.pixelOut.textContent = size.width + '×' + size.height;
      el.pixelOut.classList.remove('is-error');
      return;
    }
    var pixels = size.width * size.height;
    var over = pixels > limits.maxPixels;
    el.pixelOut.textContent = (pixels / 1000000).toFixed(2) + ' MPix' + (over ? ' — over cap' : '');
    el.pixelOut.classList.toggle('is-error', over);
  }

  function frameOptions() {
    var frames = [];
    for (var value = limits.minFrames; value <= limits.maxFrames; value += limits.frameStep) {
      frames.push(value);
    }
    return frames;
  }

  function buildLengthSlider(keep) {
    if (!el.length || !limits) return;
    if (isCloud()) {
      var model = currentModel();
      el.length.min = String(model.minSeconds);
      el.length.max = String(model.maxSeconds);
      el.length.value = String(Models.clampSeconds(model, keep && keep.seconds));
      updateLengthOut();
      return;
    }
    el.length.min = 0;
    var frames = frameOptions();
    el.length.min = 0;
    el.length.max = String(Math.max(frames.length - 1, 0));
    var defaultIndex = frames.indexOf(limits.defaultLength);
    el.length.value = String(defaultIndex >= 0 ? defaultIndex : Math.max(frames.length - 1, 0));
    updateLengthOut();
  }

  /** A cloud model's length in whole seconds; the slider holds them directly. */
  function currentSeconds() {
    return Models.clampSeconds(currentModel(), el.length && el.length.value);
  }

  function currentFrames() {
    if (isCloud()) return Math.round(currentSeconds() * (limits.fps || 24));
    var frames = frameOptions();
    var index = Math.min(frames.length - 1, Math.max(0, Number(el.length && el.length.value) || 0));
    return frames[index] || limits.minFrames;
  }

  function updateLengthOut() {
    if (!el.lengthOut || !limits) return;
    if (isCloud()) {
      el.lengthOut.textContent = currentSeconds() + 's';
      return;
    }
    var frames = currentFrames();
    var seconds = limits.fps > 0 ? frames / limits.fps : 0;
    el.lengthOut.textContent = seconds.toFixed(1) + 's · ' + frames + 'f';
  }

  function applyLimits() {
    fillModels();
    fillSelect(el.sampler, limits.samplers, limits.defaultSampler);
    fillSelect(el.scheduler, limits.schedulers, limits.defaultScheduler);
    if (el.steps) el.steps.value = limits.defaultSteps;
    syncFlowFields();
    applyModel();
  }

  function updateSlotsHint() {
    if (!el.slots || !limits) return;
    if (isCloud()) {
      // Cloud jobs never take a GPU slot; Seevio runs two of each owner's at a time.
      var mine = ownKind(state.jobs).filter(function (job) {
        return Models.isCloudJob(job) && (job.status === 'queued' || job.status === 'running');
      });
      var running = mine.filter(function (job) { return job.status === 'running'; }).length;
      var cloudParts = [running + ' of 2 running at ' + Models.providerLabel(currentModel())];
      if (mine.length > running) cloudParts.push((mine.length - running) + ' waiting');
      if (limits.quotaBytesPerUser) {
        cloudParts.push(formatBytes(limits.usedBytes) + ' of ' + formatBytes(limits.quotaBytesPerUser) + ' stored');
      }
      el.slots.textContent = cloudParts.join(' · ');
      return;
    }
    var queue = state.queue;
    var inFlight = queue ? queue.myInFlight : 0;
    var staged = queue ? queue.myStaged : 0;
    var parts = [inFlight + ' of ' + limits.maxInFlightPerUser + ' slots in use'];
    if (staged) parts.push(staged + ' waiting in your backlog');
    if (limits.quotaBytesPerUser) {
      parts.push(formatBytes(limits.usedBytes) + ' of ' + formatBytes(limits.quotaBytesPerUser) + ' stored');
    }
    el.slots.textContent = parts.join(' · ');
  }

  // ── reference rails ─────────────────────────────────────────────────────

  function renderRails() {
    RAILS.forEach(function (rail) {
      var container = studio.querySelector('[data-rail-slots="' + rail + '"]');
      var counter = studio.querySelector('[data-rail-count="' + rail + '"]');
      if (!container) return;

      var max = maxFor(rail);
      if (counter) counter.textContent = picks[rail].length + ' / ' + max;

      container.textContent = '';
      picks[rail].forEach(function (pick, slot) {
        container.appendChild(filledSlot(rail, slot, pick));
      });

      // The next empty placeholder only appears while there is room left.
      if (picks[rail].length < max) {
        container.appendChild(emptySlot(rail));
      }
    });
  }

  function filledSlot(rail, slot, pick) {
    var wrap = node('div', 'h3-slot is-filled');

    if (rail === 'image') {
      var img = document.createElement('img');
      img.src = assetUrl(pick.id);
      img.alt = pick.filename || '';
      img.loading = 'lazy';
      wrap.appendChild(img);
    } else {
      // The filename stays as the fallback glyph, so a row with no poster looks unchanged.
      posterInto(wrap, (rail === 'video' || pick.hasPoster) ? pick.id : null,
        pick.filename || rail, 'h3-slot-kindmark');
      if (rail === 'video') attachHoverPreview(wrap, pick.id);
      wrap.title = pick.filename || '';

      // Only the duration fits in 88px; the full size caption lives in the picker.
      var slotMeta = formatDuration(pick.durationSeconds);
      if (slotMeta) wrap.appendChild(node('div', 'h3-slot-meta', slotMeta));
    }

    var tag = node('button', 'h3-slot-tag', tagFor(rail, slot));
    tag.type = 'button';
    tag.title = 'Insert this tag into the prompt';
    tag.addEventListener('click', function () { insertTag(tagFor(rail, slot)); });
    wrap.appendChild(tag);

    if (rail === 'video') {
      var audio = node('button', 'h3-slot-audio' + (pick.withAudio ? ' is-on' : ''), 'AUD');
      audio.type = 'button';
      audio.title = pick.withAudio ? 'Its soundtrack is used' : 'Use its soundtrack too';
      audio.addEventListener('click', function () {
        pick.withAudio = !pick.withAudio;
        renderRails();
      });
      wrap.appendChild(audio);
    }

    var remove = node('button', 'h3-slot-remove', '×');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', 'Remove reference');
    remove.addEventListener('click', function () {
      // Slots have to stay contiguous — the backend rejects a gap — so removing one
      // renumbers everything after it, and the prompt tags shift with it.
      picks[rail].splice(slot, 1);
      renderRails();
    });
    wrap.appendChild(remove);

    return wrap;
  }

  function emptySlot(rail) {
    var button = node('button', 'h3-slot');
    button.type = 'button';
    button.title = 'Add a ' + rail + ' reference';
    button.appendChild(node('span', 'h3-slot-glyph', '+'));
    button.addEventListener('click', function () { openRefPicker(rail); });
    return button;
  }

  function insertTag(tag) {
    if (!el.prompt) return;
    var start = el.prompt.selectionStart;
    var end = el.prompt.selectionEnd;
    var value = el.prompt.value;
    if (typeof start !== 'number') {
      el.prompt.value = value + tag;
    } else {
      el.prompt.value = value.slice(0, start) + tag + value.slice(end);
      var caret = start + tag.length;
      el.prompt.setSelectionRange(caret, caret);
    }
    el.prompt.focus();
    updatePromptCount();
  }

  function updatePromptCount() {
    if (!el.promptCount || !el.prompt) return;
    el.promptCount.textContent = el.prompt.value.length + ' / 8000';
  }

  // ── the reference picker ────────────────────────────────────────────────

  function openRefPicker(rail) {
    Gen.openPicker(rail, {
      onPick: function (pick) {
        picks[rail].push(pick);
        renderRails();
      },
      onUploaded: refreshLimits
    });
  }

  // ── advanced ────────────────────────────────────────────────────────────

  /** Picking Fused turbo pre-fills its schedule as a starting point; the fields stay editable. */
  function syncFlowFields() {
    var fused = !!el.flow && el.flow.value === 'fused';
    if (fused && limits) {
      if (el.sampler) el.sampler.value = limits.fusedSampler;
      if (el.scheduler) el.scheduler.value = limits.fusedScheduler;
      if (el.steps) el.steps.value = limits.fusedSteps;
    }
  }

  // ── job list and results shelf ──────────────────────────────────────────

  function renderJobs(jobs) {
    if (!el.jobsList) return;
    el.jobsList.textContent = '';

    if (!jobs.length) {
      el.jobsList.appendChild(node('div', 'admin-empty', 'No jobs in flight.'));
      if (el.mineHint) el.mineHint.textContent = '';
      return;
    }

    if (el.mineHint && limits) {
      var staged = jobs.filter(function (job) { return job.status === 'staged'; }).length;
      el.mineHint.textContent = staged ? staged + ' waiting for a free slot' : '';
    }

    jobs.forEach(function (job) {
      var card = node('article', 'h3-job');
      card.dataset.status = job.status;

      var main = node('div', 'h3-job-main');
      main.appendChild(node('div', 'h3-job-prompt', job.prompt));

      var meta = node('div', 'h3-job-meta');
      meta.appendChild(node('span', null, statusLabel(job)));
      meta.appendChild(node('span', null, Gen.sizeLabel(job)));
      if (job.refs && job.refs.length) {
        meta.appendChild(node('span', null, job.refs.length + ' reference' + (job.refs.length === 1 ? '' : 's')));
      }
      main.appendChild(meta);

      if (job.lastError) main.appendChild(node('div', 'h3-job-error', job.lastError));
      card.appendChild(main);

      var side = node('div', 'h3-job-side');
      if (job.status === 'staged') side.appendChild(node('span', 'h3-badge is-staged', 'Backlog'));

      var actions = node('div', 'h3-job-actions');
      if (job.status === 'staged' || job.status === 'queued' || job.status === 'running') {
        var cancel = node('button', 'btn-ghost h3-small-btn', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', function () { cancelJob(job.id); });
        actions.appendChild(cancel);
      }
      var reuse = node('button', 'btn-ghost h3-small-btn', 'Reuse');
      reuse.type = 'button';
      reuse.title = 'Load these settings into the composer';
      reuse.addEventListener('click', function () { reuseJob(job); });
      actions.appendChild(reuse);
      side.appendChild(actions);

      card.appendChild(side);
      el.jobsList.appendChild(card);
    });
  }

  function renderShelf(shelf) {
    if (!el.shelf) return;
    el.shelf.textContent = '';

    if (!shelf.length) {
      el.shelf.appendChild(node('div', 'admin-empty', 'Finished renders from the last 24 hours land here.'));
      if (el.clearNew) el.clearNew.hidden = true;
      return;
    }

    var unseen = shelf.filter(function (job) { return !job.resultSeen; }).length;
    if (el.clearNew) el.clearNew.hidden = unseen === 0;

    shelf.forEach(function (job) {
      // A failure belongs here too — it is the only place the operator would ever read why,
      // since the live list drops a job the moment it stops being live.
      var failed = !job.resultAssetId;
      var item = node('button', 'h3-shelf-item' + (job.resultSeen ? '' : ' is-unseen')
        + (failed ? ' is-failed' : ''));
      item.type = 'button';

      var label = node('span', 'h3-shelf-label', job.prompt || 'Render');
      if (failed && job.lastError) label.title = job.lastError;
      item.appendChild(label);

      if (!job.resultSeen) item.appendChild(node('span', 'h3-badge is-new', 'New'));
      item.appendChild(failed
        ? node('span', 'h3-badge is-failed', 'Failed')
        : node('span', 'h3-badge', Number(job.seconds || 0).toFixed(1) + 's'));

      item.addEventListener('click', function () {
        if (failed) {
          setStatus(job.lastError || 'That render failed.', true);
          markSeen(job);
          return;
        }
        showPreview(job, true);
      });

      el.shelf.appendChild(item);
    });
  }

  function markSeen(job) {
    if (job.resultSeen) return;
    job.resultSeen = true;
    renderShelf(ownKind(state.shelf));
    api('/seen', { method: 'POST', body: { jobIds: [job.id] } }).catch(function () {});
  }

  function showPreview(job, alsoMarkSeen) {
    if (!el.previewStage || !job.resultAssetId) return;

    previewJobId = job.id;
    var url = job.resultUrl || assetUrl(job.resultAssetId);

    el.previewStage.textContent = '';
    if (Gen.isImage(job)) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = job.prompt || '';
      el.previewStage.appendChild(img);
    } else {
      var video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      el.previewStage.appendChild(video);
    }
    mountFrameTool(job, Gen.isImage(job) ? null : el.previewStage.querySelector('video'));

    if (el.previewTitle) el.previewTitle.textContent = job.prompt || 'Render';
    if (el.previewActions) el.previewActions.hidden = false;
    if (el.previewDownload) el.previewDownload.href = url;

    if (alsoMarkSeen) markSeen(job);
  }

  function mountFrameTool(job, video) {
    if (!el.previewFrames) return;
    el.previewFrames.textContent = '';
    el.previewFrames.hidden = !video;
    if (!video) return;
    el.previewFrames.appendChild(Gen.frameTool({
      video: video,
      assetId: job.resultAssetId,
      onExtend: function (frame) { return extendJob(job, frame, job.resultAssetId); },
      onExtendPlus: function (frame) { return extendPlusJob(job, frame); },
      extendPlusBlocked: Gen.extendPlusBlocked(limits)
    }));
  }

  function setContinuation(next) {
    continuation = next;
    if (el.contNote) el.contNote.hidden = !next;
    if (el.contText && next) {
      el.contText.textContent = 'Extend+ from frame ' + next.frame + ' of ' + (next.filename || 'your clip') +
        ': the render starts from the moments leading up to it, in its size, and the take keeps only the new part. ' +
        'Length is the new part.';
    }
  }

  // Extend+: the clip's settings and references come back with a fresh seed, and the render itself
  // continues the clip from the chosen frame (no saved picture). Its idea box opens like Extend's.
  async function extendPlusJob(job, frame) {
    var summary = await Gen.summarizeScene(job.resultAssetId);
    reuseJob(job, { extendPlus: { frame: frame, sourceAssetId: job.resultAssetId, filename: '', summary: summary } });
    if (studio) studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Extend: the clip's settings and references come back with a fresh seed, the saved frame
  // takes the continuation slot, and the idea box opens on a short summary of the clip so far.
  // The specialist is not asked yet: the operator writes the next scene first.
  async function extendJob(job, frameAsset, videoAssetId) {
    var summary = await Gen.summarizeScene(videoAssetId);
    reuseJob(job, { continueFrom: { asset: frameAsset, summary: summary } });
    if (studio) studio.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Grows with its text up to the CSS max-height, so a carried-over scene stays readable.
  function growIdea() {
    if (!el.idea) return;
    el.idea.style.height = 'auto';
    el.idea.style.height = (el.idea.scrollHeight + 2) + 'px';
  }

  // opts (from the gallery's Repeat/Vary): keepSeed re-renders the same seed, idea refills the idea box.
  // opts.continueFrom { asset, summary } (Extend): new seed, empty prompt, the frame as the continuation picture.
  // opts.extendPlus { frame, sourceAssetId, filename, summary } (Extend+): as Extend, but the render continues the clip.
  function reuseJob(job, opts) {
    opts = opts || {};
    if (limits && limits.canGenerateLocal === false && (!Models.isCloudJob(job) || opts.continueFrom || opts.extendPlus)) {
      setStatus('Local H3 generation requires Creator access.', true);
      return;
    }
    var cont = opts.continueFrom || null;
    var plus = opts.extendPlus || null;
    var missingModel = false;
    if (plus && el.model) {
      el.model.value = 'minimax-h3';
    } else if (el.model && job.model) {
      var offered = Array.prototype.some.call(el.model.options, function (option) { return option.value === job.model; });
      if (offered) el.model.value = job.model;
      else missingModel = Models.isCloudJob(job);
    }
    applyModel();
    var cloud = isCloud();
    if (el.idea && opts.idea !== undefined) el.idea.value = opts.idea || '';
    // A continuation gets a new prompt from the specialist; the old one would be taken as a draft.
    if (el.prompt) el.prompt.value = cont || plus ? '' : (job.prompt || '');
    updatePromptCount();

    picks = { image: [], audio: [], video: [] };
    (job.refs || []).slice().sort(function (a, b) { return a.slot - b.slot; }).forEach(function (ref) {
      if (!picks[ref.rail]) return;
      picks[ref.rail].push({ id: ref.assetId, filename: ref.filename || '', withAudio: Boolean(ref.withAudio) });
    });
    if (cont || plus) picks.image = picks.image.filter(function (pick) { return !Gen.isContinuationFrame(pick); });
    // Repeat and Vary of an Extend+ take continue the same clip from the same frame.
    var plusSource = plus || (job.continuation
      ? { frame: job.continuation.frame, sourceAssetId: job.continuation.sourceAssetId, filename: job.continuation.sourceFilename }
      : null);
    setContinuation(plusSource && !cloud
      ? { frame: plusSource.frame, sourceAssetId: plusSource.sourceAssetId, filename: plusSource.filename || '' }
      : null);
    if (plus && el.idea) {
      el.idea.value = Gen.extendPlusIdea(plus.summary);
    }
    if (cont) {
      var max = limits ? maxFor('image') : 9;
      if (picks.image.length >= max) picks.image.length = Math.max(0, max - 1);
      picks.image.push({ id: cont.asset.id, filename: cont.asset.filename || '', withAudio: false });
      if (el.idea) {
        var isLast = (cont.asset.tags || []).indexOf('last-frame') !== -1;
        el.idea.value = Gen.continuationIdea(cont.summary, tagFor('image', picks.image.length - 1), isLast);
      }
    }
    trimPicks();
    renderRails();
    growIdea();

    if (cloud) {
      if (el.size) el.size.value = Models.aspectFor(job.width, job.height);
      if (el.resolution) el.resolution.value = Models.pickResolution(currentModel(), Models.resolutionFor(job.width, job.height));
      if (el.length) el.length.value = String(Models.clampSeconds(currentModel(), job.seconds));
      updatePixelOut();
      updateLengthOut();
    } else {
      applySize(job.width, job.height);
      if (el.size) {
        var key = job.width + 'x' + job.height;
        el.size.value = Array.prototype.some.call(el.size.options, function (option) { return option.value === key; })
          ? key
          : 'custom';
      }

      var frames = frameOptions();
      // An Extend+ job's length is its raw render; the composer's length is the new part.
      var index = frames.indexOf(job.continuation ? job.continuation.deliveredFrames + limits.minFrames : job.lengthFrames);
      if (el.length && index >= 0) {
        el.length.value = String(index);
        updateLengthOut();
      }

      if (el.sampler) el.sampler.value = job.sampler;
      if (el.scheduler) el.scheduler.value = job.scheduler;
      if (el.steps) el.steps.value = job.steps;
      if (el.flow) el.flow.value = job.flow || 'auto';
      syncFlowFields();
      if (el.refImageSize) el.refImageSize.value = job.refImageSize;
    }
    if (el.seed) el.seed.value = opts.keepSeed && job.seed ? String(job.seed) : '';

    if ((cont || plus) && el.idea) {
      setStatus(plus ? 'Extend+ loaded with a new seed.' : 'Continuation loaded with a new seed.');
      setAdviseStatus((cont || plus).summary
        ? 'Describe the next scene after “Next scene:”, then Write the prompt.'
        : 'No summary this time; describe the next scene, then Write the prompt.');
      el.idea.focus();
      el.idea.setSelectionRange(el.idea.value.length, el.idea.value.length);
      el.idea.scrollTop = el.idea.scrollHeight;
      return;
    }
    setStatus(missingModel
      ? 'That job ran on a Seevio model; save your key under Tools → AI zone to use it again. Loaded into MiniMax H3.'
      : 'Settings loaded into the composer.', missingModel);
    if (el.prompt) el.prompt.focus();
  }

  // ── actions ─────────────────────────────────────────────────────────────

  // The reference list in the exact shape the job route takes; the advisor route reuses it so
  // the specialist sees the same attachments the render will.
  function pickedRefs() {
    var refs = [];
    RAILS.forEach(function (rail) {
      picks[rail].forEach(function (pick, slot) {
        refs.push({ rail: rail, slot: slot, assetId: pick.id, withAudio: Boolean(pick.withAudio) });
      });
    });
    return refs;
  }

  // The prompt specialist: the idea box plus whatever is already in the prompt (treated as a
  // draft to revise) go to the director model, and its answer lands in the prompt box. The
  // box stays editable; nothing is queued.
  var advising = false;

  async function advisePrompt() {
    if (advising || !limits) return;

    var idea = (el.idea && el.idea.value || '').trim();
    var draft = (el.prompt && el.prompt.value || '').trim();
    if (!idea && !draft) {
      setAdviseStatus('Write your idea first.', true);
      if (el.idea) el.idea.focus();
      return;
    }

    var size = currentSize();
    var body = {
      idea: idea,
      draft: draft,
      width: size.width,
      height: size.height,
      length: currentFrames(),
      seconds: isCloud() ? currentSeconds() : undefined,
      model: el.model && el.model.value ? el.model.value : undefined,
      refs: pickedRefs()
    };

    advising = true;
    var label = el.advise ? el.advise.textContent : '';
    if (el.advise) { el.advise.disabled = true; el.advise.textContent = 'Writing…'; }
    if (el.prompt) el.prompt.classList.add('is-busy');
    setAdviseStatus(draft ? 'Revising your draft…' : 'Writing the prompt…');
    try {
      var result = await api('/prompt/advise', { method: 'POST', body: body });
      if (el.prompt) {
        el.prompt.value = result.prompt || '';
        updatePromptCount();
        el.prompt.focus();
        el.prompt.setSelectionRange(0, 0);
        el.prompt.scrollTop = 0;
      }
      setAdviseStatus(result.truncated
        ? 'Prompt written, cut to fit the 8000-character limit. Edit it freely.'
        : 'Prompt written. Edit it freely.');
    } catch (err) {
      setAdviseStatus(err.message, true);
    } finally {
      advising = false;
      if (el.advise) { el.advise.disabled = false; el.advise.textContent = label; }
      if (el.prompt) el.prompt.classList.remove('is-busy');
    }
  }

  async function submitJob(event) {
    event.preventDefault();
    if (!limits) return;
    if (limits.canGenerateLocal === false && !Models.list(limits, 'video').some(function (m) { return m.id === el.model.value; })) {
      setStatus('Add your own provider key in AI zone to use Video Generator.', true);
      return;
    }

    var prompt = (el.prompt && el.prompt.value || '').trim();
    if (!prompt) {
      setStatus('Write a prompt first.', true);
      if (el.prompt) el.prompt.focus();
      return;
    }

    if (isCloud()) {
      await submitCloud(prompt);
      return;
    }

    var size = currentSize();
    if (size.width * size.height > limits.maxPixels) {
      setStatus('That size is over the ' + (limits.maxPixels / 1000000).toFixed(2) + ' MPix cap.', true);
      return;
    }

    var seedValue = String(el.seed && el.seed.value || '0').trim();
    var body = {
      prompt: prompt,
      width: size.width,
      height: size.height,
      length: currentFrames(),
      refImageSize: el.refImageSize ? el.refImageSize.value : 'match',
      sampler: el.sampler ? el.sampler.value : limits.defaultSampler,
      scheduler: el.scheduler ? el.scheduler.value : limits.defaultScheduler,
      steps: Number(el.steps && el.steps.value) || limits.defaultSteps,
      seed: /^[0-9]{1,19}$/.test(seedValue) && BigInt(seedValue) > 0n ? seedValue : 0,
      flow: el.flow ? el.flow.value : 'auto',
      model: el.model && el.model.value ? el.model.value : undefined,
      refs: pickedRefs(),
      idea: (el.idea && el.idea.value || '').trim() || undefined,
      continuation: continuation ? { sourceAssetId: continuation.sourceAssetId, frame: continuation.frame } : undefined
    };

    if (el.submit) el.submit.disabled = true;
    setStatus('Queueing...');
    try {
      var job = await api('/jobs', { method: 'POST', body: body });
      setStatus(job.status === 'staged'
        ? 'Both your slots are busy — queued in your backlog.'
        : 'Queued.');
      await Gen.refresh();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (el.submit) el.submit.disabled = false;
    }
  }

  // A cloud job: whole seconds, an aspect and a resolution, the seed only if the model takes one. It goes
  // straight to the Seevio line, never to the GPU queue or the backlog.
  async function submitCloud(prompt) {
    var model = currentModel();
    var size = cloudSize();
    var seedValue = String(el.seed && el.seed.value || '0').trim();
    var body = {
      prompt: prompt,
      model: model.id,
      seconds: currentSeconds(),
      aspect: el.size ? el.size.value : '16:9',
      cloudResolution: Models.pickResolution(model, el.resolution && el.resolution.value),
      width: size.width,
      height: size.height,
      seed: model.supportsSeed !== false && /^[0-9]{1,19}$/.test(seedValue) && BigInt(seedValue) > 0n ? seedValue : 0,
      refs: pickedRefs(),
      idea: (el.idea && el.idea.value || '').trim() || undefined
    };

    if (el.submit) el.submit.disabled = true;
    setStatus('Sending...');
    try {
      await api('/jobs', { method: 'POST', body: body });
      setStatus('Queued for ' + Models.providerLabel(model) + '.');
      await Gen.refresh();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      if (el.submit) el.submit.disabled = false;
    }
  }

  async function cancelJob(jobId) {
    setStatus('Cancelling...');
    try {
      await api('/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
      setStatus('Cancelled.');
      await Gen.refresh();
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function shareResult() {
    var job = state.shelf.filter(function (candidate) { return candidate.id === previewJobId; })[0];
    if (!job || !job.resultAssetId) {
      setStatus('Open a finished render first.', true);
      return;
    }
    try {
      await api('/assets/' + encodeURIComponent(job.resultAssetId) + '/share', { method: 'POST' });
      setStatus('Sent to Shared Media Assets — it appears there once an asset manager approves it.');
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  // Only this studio's results: an empty list would mark the Image Generator's shelf seen too.
  async function markAllSeen() {
    var unseen = ownKind(state.shelf).filter(function (job) { return !job.resultSeen; });
    if (!unseen.length) return;
    try {
      await api('/seen', { method: 'POST', body: { jobIds: unseen.map(function (job) { return job.id; }) } });
      unseen.forEach(function (job) { job.resultSeen = true; });
      renderShelf(ownKind(state.shelf));
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  // ── the shared poll ─────────────────────────────────────────────────────

  var queueView = Gen.queueView({ bar: el.queueBar, count: el.queueCount, detail: el.queueDetail });
  var gpuView = Gen.gpuView({ strip: el.gpuStrip, cards: el.gpuCards, mode: el.gpuMode });

  function render(current, info) {
    if (!started || !limits) return;
    if (info && info.error) {
      setStatus(info.error.message, true);
      return;
    }
    queueView.render(current.queue, current.jobs);
    gpuView.render(current.gpus);
    renderJobs(ownKind(current.jobs));
    renderShelf(ownKind(current.shelf));
    updateSlotsHint();

    var succeeded = ownKind((info && info.finished) || []).filter(function (job) {
      return job.status === 'completed';
    }).length;
    if (succeeded) setStatus(succeeded === 1 ? 'A render finished.' : succeeded + ' renders finished.');
  }

  async function refreshLimits() {
    try {
      limits = await Gen.loadLimits(true);
      updateSlotsHint();
    } catch (err) { /* the hint just keeps its previous numbers */ }
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  if (el.prompt) el.prompt.addEventListener('input', updatePromptCount);
  if (el.length) el.length.addEventListener('input', updateLengthOut);
  if (el.width) el.width.addEventListener('change', function () {
    el.width.value = snapDimension(el.width.value);
    if (el.size) el.size.value = 'custom';
    updatePixelOut();
  });
  if (el.height) el.height.addEventListener('change', function () {
    el.height.value = snapDimension(el.height.value);
    if (el.size) el.size.value = 'custom';
    updatePixelOut();
  });
  if (el.model) el.model.addEventListener('change', function () { setStatus(''); applyModel(); });
  if (el.resolution) el.resolution.addEventListener('change', updatePixelOut);
  if (el.size) el.size.addEventListener('change', function () {
    if (isCloud()) {
      updatePixelOut();
      return;
    }
    if (el.size.value === 'custom') return;
    var parts = el.size.value.split('x');
    applySize(Number(parts[0]), Number(parts[1]));
  });
  if (el.flow) el.flow.addEventListener('change', syncFlowFields);
  if (el.form) el.form.addEventListener('submit', submitJob);
  if (el.advise) el.advise.addEventListener('click', advisePrompt);
  if (el.contClear) {
    el.contClear.addEventListener('click', function () {
      setContinuation(null);
      setStatus('Extend+ cancelled; this queues an ordinary render.');
    });
  }
  if (el.idea) el.idea.addEventListener('input', growIdea);
  if (el.idea) el.idea.addEventListener('keydown', function (event) {
    // Ctrl/Cmd+Enter in the idea box asks the specialist; plain Enter keeps typing.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      advisePrompt();
    }
  });
  if (el.clearNew) el.clearNew.addEventListener('click', markAllSeen);
  if (el.previewShare) el.previewShare.addEventListener('click', shareResult);

  Gen.bindBell(el.bell);
  Gen.subscribe(render);

  // Saving or deleting a key in the AI zone adds or removes the cloud models.
  document.addEventListener('mv:api-keys-changed', async function () {
    if (!started || !limits) return;
    try {
      limits = await Gen.loadLimits(true);
      fillModels();
      applyModel();
    } catch (err) { /* the picker keeps what it had */ }
  });

  async function start() {
    if (started) return;
    started = true;

    if (!await Gen.resolveRoles()) {
      studio.remove();
      return;
    }

    studio.hidden = false;
    // The studio owns the first sub-tab of the Tools row once the gate passes; it becomes the
    // default tool unless the operator has already picked one by hand.
    if (typeof window.revealToolTab === 'function') window.revealToolTab('h3', true);
    setStatus('Loading...');
    try {
      limits = await Gen.loadLimits();
    } catch (err) {
      setStatus(err.message, true);
      return;
    }

    applyLimits();
    updatePromptCount();
    Gen.provideComposer('video', reuseJob);
    render(state, null);
    await Gen.refresh();
    setStatus(limits.canGenerateLocal === false && !Models.list(limits, 'video').length ? 'Add your own provider key in AI zone to use Video Generator.' : '');
  }

  // The Tools tab owns the lifecycle: account.js calls loadAccountTools when it first opens,
  // so chain onto it rather than racing it for the same moment.
  Gen.onToolsOpen(start);
})();
