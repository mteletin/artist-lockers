/* Image Generator studio (Qwen-Image 2.1 for now), inside the account Tools tab.

   It is the Video Generation studio's sibling: the same queue, the same shelf, the same picker
   and the same markup classes, so everything here that is not about pictures comes from
   account-gen-shared.js (window.MvGen). The queue bar counts every job; the lists keep to image
   jobs. Results land in the owner's pool like any upload, so they can be picked as references
   anywhere, and only go public through the usual Send-to-Shared-Media-Assets moderation. */
(function () {
  'use strict';

  var studio = document.querySelector('#imgStudio');
  var Gen = window.MvGen;
  if (!studio || !Gen) return;

  var MAX_PROMPT = 8000;
  var MODE_HINTS = {
    create: 'A new picture from the prompt. Attached pictures steer its content or style.',
    edit: 'Changes <image1> the way the prompt says. The result keeps its size.',
    transparent: 'A new picture on a transparent background, saved as PNG.',
    'remove-bg': 'Cuts <image1> out of its background. The prompt is optional.'
  };
  var ASPECT_LABELS = {
    '1:1': 'Square 1:1',
    '16:9': 'Landscape 16:9',
    '9:16': 'Portrait 9:16',
    '4:3': 'Classic 4:3',
    '3:4': 'Portrait 3:4',
    '3:2': 'Photo 3:2',
    '2:3': 'Portrait 2:3'
  };

  var limits = null;
  var state = Gen.state;
  var picks = [];
  var mode = 'create';
  var started = false;
  var previewJobId = null;

  var el = {
    status: document.querySelector('#imgStatus'),
    bell: document.querySelector('#imgBellToggle'),
    model: document.querySelector('#imgModel'),
    modes: document.querySelector('#imgModes'),
    modeHint: document.querySelector('#imgModeHint'),
    queueBar: document.querySelector('#imgQueueBar'),
    queueCount: document.querySelector('#imgQueueCount'),
    queueDetail: document.querySelector('#imgQueueDetail'),
    gpuStrip: document.querySelector('#imgGpuStrip'),
    gpuCards: document.querySelector('#imgGpuCards'),
    gpuMode: document.querySelector('#imgGpuMode'),
    form: document.querySelector('#imgForm'),
    idea: document.querySelector('#imgIdea'),
    advise: document.querySelector('#imgAdvise'),
    adviseStatus: document.querySelector('#imgAdviseStatus'),
    prompt: document.querySelector('#imgPrompt'),
    promptCount: document.querySelector('#imgPromptCount'),
    aspect: document.querySelector('#imgAspect'),
    sizeOut: document.querySelector('#imgSizeOut'),
    quality: document.querySelector('#imgQuality'),
    variants: document.querySelector('#imgVariants'),
    sampler: document.querySelector('#imgSampler'),
    scheduler: document.querySelector('#imgScheduler'),
    steps: document.querySelector('#imgSteps'),
    cfg: document.querySelector('#imgCfg'),
    seed: document.querySelector('#imgSeed'),
    negative: document.querySelector('#imgNegative'),
    submit: document.querySelector('#imgSubmit'),
    slots: document.querySelector('#imgSlots'),
    previewTitle: document.querySelector('#imgPreviewTitle'),
    previewStage: document.querySelector('#imgPreviewStage'),
    previewActions: document.querySelector('#imgPreviewActions'),
    previewDownload: document.querySelector('#imgPreviewDownload'),
    previewUse: document.querySelector('#imgPreviewUse'),
    previewShare: document.querySelector('#imgPreviewShare'),
    jobsList: document.querySelector('#imgJobsList'),
    mineHint: document.querySelector('#imgMineHint'),
    shelf: document.querySelector('#imgShelf'),
    clearNew: document.querySelector('#imgClearNew')
  };

  var escapeHtml = Gen.escapeHtml;
  var node = Gen.node;
  var api = Gen.api;
  var assetUrl = Gen.assetUrl;
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

  /** Qwen reads its pictures as <image1>, <image2>... in slot order. */
  function tagFor(slot) {
    return '<image' + (slot + 1) + '>';
  }

  function image() {
    return (limits && limits.image) || null;
  }

  function maxRefs() {
    return image() ? image().maxRefs : 0;
  }

  function ownKind(jobs) {
    return (jobs || []).filter(Gen.isImage);
  }

  /** Edit and Remove background work on <image1>, so its size decides the output. */
  function followsPicture() {
    return mode === 'edit' || mode === 'remove-bg';
  }

  // ── controls ────────────────────────────────────────────────────────────

  function fillModels() {
    if (!el.model) return;
    var models = ((limits && limits.models) || []).filter(function (model) {
      return model.kind === 'image' && model.enabled;
    });
    if (!models.length && image()) models = [{ id: image().model, label: 'Qwen-Image 2.1' }];
    el.model.innerHTML = models.map(function (model) {
      return '<option value="' + escapeHtml(model.id) + '">' + escapeHtml(model.label) + '</option>';
    }).join('');
    el.model.disabled = models.length < 2;
  }

  // The model's own sampler and scheduler are the default; an empty value lets the backend
  // pick them from the admin settings instead of the studio guessing.
  function fillDefaulted(select, values) {
    if (!select) return;
    select.innerHTML = '<option value="">Model default</option>' + (values || []).map(function (value) {
      return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>';
    }).join('');
  }

  function sizesFor(resolution) {
    var sizes = image() && image().sizes;
    return (sizes && (sizes[resolution] || sizes[String(resolution)])) || {};
  }

  function currentResolution() {
    return Number(el.quality && el.quality.value) || 1024;
  }

  function buildAspects() {
    if (!el.aspect) return;
    var keep = el.aspect.value || '1:1';
    var sizes = sizesFor(currentResolution());
    el.aspect.innerHTML = Object.keys(sizes).map(function (key) {
      return '<option value="' + escapeHtml(key) + '">' + escapeHtml(ASPECT_LABELS[key] || key) + '</option>';
    }).join('');
    el.aspect.value = sizes[keep] ? keep : (sizes['1:1'] ? '1:1' : Object.keys(sizes)[0] || '');
    updateSizeOut();
  }

  function currentSize() {
    if (followsPicture() && picks[0] && picks[0].mediaWidth && picks[0].mediaHeight) {
      return { width: picks[0].mediaWidth, height: picks[0].mediaHeight };
    }
    var size = sizesFor(currentResolution())[el.aspect && el.aspect.value];
    return size ? { width: size[0], height: size[1] } : { width: 1024, height: 1024 };
  }

  function updateSizeOut() {
    if (!el.sizeOut) return;
    if (followsPicture()) {
      el.sizeOut.textContent = 'follows <image1>';
      return;
    }
    var size = currentSize();
    el.sizeOut.textContent = size.width + '×' + size.height;
  }

  function setMode(next) {
    mode = next;
    if (el.modes) {
      el.modes.querySelectorAll('[data-mode]').forEach(function (button) {
        var on = button.dataset.mode === mode;
        button.classList.toggle('is-active', on);
        button.setAttribute('aria-checked', String(on));
      });
    }
    if (el.modeHint) el.modeHint.textContent = MODE_HINTS[mode] || '';
    if (el.aspect) el.aspect.disabled = followsPicture();
    if (el.prompt) {
      el.prompt.placeholder = mode === 'remove-bg'
        ? 'Optional: anything to keep or fix, e.g. keep the microphone stand.'
        : 'Describe the picture. Reference an attachment by its tag, e.g. the jacket from <image1> on the singer in <image2>.';
    }
    updateSizeOut();
  }

  function applyLimits() {
    fillModels();
    fillDefaulted(el.sampler, limits.samplers);
    fillDefaulted(el.scheduler, limits.schedulers);
    if (el.steps && image()) el.steps.value = image().defaultSteps;
    if (el.cfg && image()) el.cfg.placeholder = 'Auto (' + image().cfg + ', ' + image().refCfg + ' with pictures)';
    buildAspects();
    setMode(mode);
    renderRails();
    updateSlotsHint();
  }

  function updateSlotsHint() {
    if (!el.slots || !limits) return;
    var queue = state.queue;
    var inFlight = queue ? queue.myInFlight : 0;
    var staged = queue ? queue.myStaged : 0;
    // Shared with Video Generation: both studios draw on the same per-user slots.
    var parts = [inFlight + ' of ' + limits.maxInFlightPerUser + ' slots in use'];
    if (staged) parts.push(staged + ' waiting in your backlog');
    el.slots.textContent = parts.join(' · ');
  }

  // ── the reference rail ──────────────────────────────────────────────────

  function renderRails() {
    var container = studio.querySelector('[data-rail-slots="image"]');
    var counter = studio.querySelector('[data-rail-count="image"]');
    if (!container) return;

    var max = maxRefs();
    if (counter) counter.textContent = picks.length + ' / ' + max;

    container.textContent = '';
    picks.forEach(function (pick, slot) {
      container.appendChild(filledSlot(slot, pick));
    });
    if (picks.length < max) container.appendChild(emptySlot());
    updateSizeOut();
  }

  function filledSlot(slot, pick) {
    var wrap = node('div', 'h3-slot is-filled');
    var img = document.createElement('img');
    img.src = assetUrl(pick.id);
    img.alt = pick.filename || '';
    img.loading = 'lazy';
    wrap.appendChild(img);
    wrap.title = pick.filename || '';

    var tag = node('button', 'h3-slot-tag', tagFor(slot));
    tag.type = 'button';
    tag.title = 'Insert this tag into the prompt';
    tag.addEventListener('click', function () { insertTag(tagFor(slot)); });
    wrap.appendChild(tag);

    var remove = node('button', 'h3-slot-remove', '×');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', 'Remove reference');
    remove.addEventListener('click', function () {
      // Contiguous slots, as on the video side: the tags after it shift down by one.
      picks.splice(slot, 1);
      renderRails();
    });
    wrap.appendChild(remove);
    return wrap;
  }

  function emptySlot() {
    var button = node('button', 'h3-slot');
    button.type = 'button';
    button.title = 'Add a picture';
    button.appendChild(node('span', 'h3-slot-glyph', '+'));
    button.addEventListener('click', function () {
      Gen.openPicker('image', {
        onPick: function (pick) {
          picks.push(pick);
          renderRails();
        },
        onUploaded: refreshLimits
      });
    });
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
    el.promptCount.textContent = el.prompt.value.length + ' / ' + MAX_PROMPT;
  }

  function pickedRefs() {
    return picks.map(function (pick, slot) {
      return { rail: 'image', slot: slot, assetId: pick.id, withAudio: false };
    });
  }

  // ── job list and results shelf ──────────────────────────────────────────

  function modeLabel(value) {
    if (value === 'remove-bg') return 'remove background';
    return value || 'create';
  }

  function renderJobs(jobs) {
    if (!el.jobsList) return;
    el.jobsList.textContent = '';

    if (!jobs.length) {
      el.jobsList.appendChild(node('div', 'admin-empty', 'No jobs in flight.'));
      if (el.mineHint) el.mineHint.textContent = '';
      return;
    }

    if (el.mineHint) {
      var staged = jobs.filter(function (job) { return job.status === 'staged'; }).length;
      el.mineHint.textContent = staged ? staged + ' waiting for a free slot' : '';
    }

    jobs.forEach(function (job) {
      var card = node('article', 'h3-job');
      card.dataset.status = job.status;

      var main = node('div', 'h3-job-main');
      main.appendChild(node('div', 'h3-job-prompt', job.prompt || modeLabel(job.mode)));

      var meta = node('div', 'h3-job-meta');
      meta.appendChild(node('span', null, statusLabel(job)));
      meta.appendChild(node('span', null, modeLabel(job.mode) + ' · ' + Gen.sizeLabel(job)));
      if (job.refs && job.refs.length) {
        meta.appendChild(node('span', null, job.refs.length + ' picture' + (job.refs.length === 1 ? '' : 's')));
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
      el.shelf.appendChild(node('div', 'admin-empty', 'Finished pictures from the last 24 hours land here.'));
      if (el.clearNew) el.clearNew.hidden = true;
      return;
    }

    var unseen = shelf.filter(function (job) { return !job.resultSeen; }).length;
    if (el.clearNew) el.clearNew.hidden = unseen === 0;

    shelf.forEach(function (job) {
      var failed = !job.resultAssetId;
      var item = node('button', 'h3-shelf-item' + (job.resultSeen ? '' : ' is-unseen')
        + (failed ? ' is-failed' : ''));
      item.type = 'button';

      var label = node('span', 'h3-shelf-label', job.prompt || modeLabel(job.mode));
      if (failed && job.lastError) label.title = job.lastError;
      item.appendChild(label);

      if (!job.resultSeen) item.appendChild(node('span', 'h3-badge is-new', 'New'));
      item.appendChild(failed
        ? node('span', 'h3-badge is-failed', 'Failed')
        : node('span', 'h3-badge', job.width + '×' + job.height));

      item.addEventListener('click', function () {
        if (failed) {
          setStatus(job.lastError || 'That picture failed.', true);
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
    var img = document.createElement('img');
    img.src = url;
    img.alt = job.prompt || '';
    el.previewStage.appendChild(img);

    if (el.previewTitle) el.previewTitle.textContent = job.prompt || modeLabel(job.mode);
    if (el.previewActions) el.previewActions.hidden = false;
    if (el.previewDownload) el.previewDownload.href = url;

    if (alsoMarkSeen) markSeen(job);
  }

  function previewJob() {
    return state.shelf.filter(function (candidate) { return candidate.id === previewJobId; })[0];
  }

  // opts (from the gallery's Repeat/Vary): keepSeed re-renders the same seed, idea refills the idea box.
  function reuseJob(job, opts) {
    opts = opts || {};
    if (el.model && job.model && Array.prototype.some.call(el.model.options, function (option) { return option.value === job.model; })) {
      el.model.value = job.model;
    }
    if (el.idea && opts.idea !== undefined) el.idea.value = opts.idea || '';
    if (el.prompt) el.prompt.value = job.prompt || '';
    updatePromptCount();

    picks = (job.refs || []).filter(function (ref) { return ref.rail === 'image'; })
      .sort(function (a, b) { return a.slot - b.slot; })
      .map(function (ref) { return { id: ref.assetId, filename: ref.filename || '' }; });

    if (el.quality) el.quality.value = String(job.refResolution === 2048 ? 2048 : 1024);
    buildAspects();
    var sizes = sizesFor(currentResolution());
    Object.keys(sizes).forEach(function (key) {
      if (sizes[key][0] === job.width && sizes[key][1] === job.height && el.aspect) el.aspect.value = key;
    });

    setMode(job.mode || 'create');
    renderRails();

    if (el.sampler) el.sampler.value = job.sampler || '';
    if (el.scheduler) el.scheduler.value = job.scheduler || '';
    if (el.steps) el.steps.value = job.steps;
    if (el.cfg) el.cfg.value = job.cfg == null ? '' : job.cfg;
    if (el.negative) el.negative.value = job.negativePrompt || '';
    if (el.seed) el.seed.value = opts.keepSeed && job.seed ? String(job.seed) : '';
    // A repeat is one render; variants would re-roll the seeds around it.
    if (el.variants && opts.keepSeed) el.variants.value = '1';

    setStatus('Settings loaded into the composer.');
    if (el.prompt) el.prompt.focus();
  }

  // ── actions ─────────────────────────────────────────────────────────────

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
      model: el.model ? el.model.value : undefined,
      mode: mode,
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
        ? 'Prompt written, cut to fit the ' + MAX_PROMPT + '-character limit. Edit it freely.'
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
    if (!limits || !image()) return;

    var prompt = (el.prompt && el.prompt.value || '').trim();
    if (!prompt && mode !== 'remove-bg') {
      setStatus('Write a prompt first.', true);
      if (el.prompt) el.prompt.focus();
      return;
    }
    if (followsPicture() && !picks.length) {
      setStatus('Pick the picture to work on first — it goes in as <image1>.', true);
      return;
    }

    var size = currentSize();
    var cfgValue = el.cfg && el.cfg.value !== '' ? Number(el.cfg.value) : null;
    var variants = Math.min(4, Math.max(1, Number(el.variants && el.variants.value) || 1));
    // Variants are separate jobs one seed apart, so a good one can be re-rolled by its seed.
    var seedValue = String(el.seed && el.seed.value || '0').trim();
    var baseSeed = /^[0-9]{1,19}$/.test(seedValue) && BigInt(seedValue) > 0n
      ? BigInt(seedValue)
      : BigInt(1 + Math.floor(Math.random() * 2147483000));

    var body = {
      model: el.model ? el.model.value : image().model,
      mode: mode,
      prompt: prompt,
      width: size.width,
      height: size.height,
      resolution: currentResolution(),
      sampler: el.sampler && el.sampler.value ? el.sampler.value : undefined,
      scheduler: el.scheduler && el.scheduler.value ? el.scheduler.value : undefined,
      steps: Number(el.steps && el.steps.value) || image().defaultSteps,
      cfg: Number.isFinite(cfgValue) ? cfgValue : undefined,
      negativePrompt: el.negative && el.negative.value.trim() ? el.negative.value.trim() : undefined,
      refs: pickedRefs(),
      idea: (el.idea && el.idea.value || '').trim() || undefined
    };

    if (el.submit) el.submit.disabled = true;
    setStatus('Queueing...');
    var queued = 0;
    var staged = 0;
    try {
      for (var i = 0; i < variants; i += 1) {
        body.seed = String(baseSeed + BigInt(i));
        var job = await api('/jobs', { method: 'POST', body: body });
        queued += 1;
        if (job.status === 'staged') staged += 1;
      }
      setStatus(staged
        ? (queued === 1 ? 'Your slots are busy — queued in your backlog.' : queued + ' queued, ' + staged + ' in your backlog.')
        : (queued === 1 ? 'Queued.' : queued + ' variants queued.'));
    } catch (err) {
      setStatus(queued ? queued + ' queued, then: ' + err.message : err.message, true);
    } finally {
      if (el.submit) el.submit.disabled = false;
      await Gen.refresh();
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
    var job = previewJob();
    if (!job || !job.resultAssetId) {
      setStatus('Open a finished picture first.', true);
      return;
    }
    try {
      await api('/assets/' + encodeURIComponent(job.resultAssetId) + '/share', { method: 'POST' });
      setStatus('Sent to Shared Media Assets — it appears there once an asset manager approves it.');
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  /** The finished picture goes back into the rail, e.g. to edit it further. */
  function useAsReference() {
    var job = previewJob();
    if (!job || !job.resultAssetId) {
      setStatus('Open a finished picture first.', true);
      return;
    }
    if (picks.some(function (pick) { return pick.id === job.resultAssetId; })) {
      setStatus('That picture is already attached.');
      return;
    }
    if (picks.length >= maxRefs()) {
      setStatus('All ' + maxRefs() + ' picture slots are full.', true);
      return;
    }
    picks.push({ id: job.resultAssetId, filename: job.prompt || 'generated', mediaWidth: job.width, mediaHeight: job.height });
    renderRails();
    setStatus('Attached as ' + tagFor(picks.length - 1) + '.');
  }

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

    var done = ownKind((info && info.finished) || []).filter(function (job) {
      return job.status === 'completed';
    });
    if (done.length) {
      setStatus(done.length === 1 ? 'A picture finished.' : done.length + ' pictures finished.');
      // Nothing on the stage yet: show the newest result straight away.
      if (!previewJobId) showPreview(done[done.length - 1], false);
    }
  }

  async function refreshLimits() {
    try {
      limits = await Gen.loadLimits(true);
      updateSlotsHint();
    } catch (err) { /* the hint just keeps its previous numbers */ }
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  if (el.prompt) el.prompt.addEventListener('input', updatePromptCount);
  if (el.modes) el.modes.addEventListener('click', function (event) {
    var button = event.target.closest('[data-mode]');
    if (button) setMode(button.dataset.mode);
  });
  if (el.quality) el.quality.addEventListener('change', buildAspects);
  if (el.aspect) el.aspect.addEventListener('change', updateSizeOut);
  if (el.form) el.form.addEventListener('submit', submitJob);
  if (el.advise) el.advise.addEventListener('click', advisePrompt);
  if (el.idea) el.idea.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      advisePrompt();
    }
  });
  if (el.clearNew) el.clearNew.addEventListener('click', markAllSeen);
  if (el.previewShare) el.previewShare.addEventListener('click', shareResult);
  if (el.previewUse) el.previewUse.addEventListener('click', useAsReference);

  Gen.bindBell(el.bell);
  Gen.subscribe(render);

  async function start() {
    if (started) return;
    started = true;

    if (!await Gen.resolveRoles()) {
      studio.remove();
      return;
    }

    try {
      limits = await Gen.loadLimits();
    } catch (err) {
      studio.hidden = false;
      if (typeof window.revealToolTab === 'function') window.revealToolTab('image');
      setStatus(err.message, true);
      return;
    }
    // No image model configured (or all switched off): the tab stays hidden.
    if (!image()) {
      studio.remove();
      return;
    }

    studio.hidden = false;
    if (typeof window.revealToolTab === 'function') window.revealToolTab('image');
    applyLimits();
    updatePromptCount();
    Gen.provideComposer('image', reuseJob);
    render(state, null);
    await Gen.refresh();
  }

  Gen.onToolsOpen(start);
})();
