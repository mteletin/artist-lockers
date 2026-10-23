(function () {
  'use strict';
  // Images made in place. An editor who may also generate asks for an image at the cursor: the server writes the
  // specialist's brief from the page and the pages around it, the prompt specialist writes the prompt, and the job goes
  // to the shared generation queue (/api/ed3/h3) as the caller's own. A genImage card carrying the job id stands in the
  // page; the page is linked to the job (/api/codex/pages/{id}/gen-jobs), so everyone who can open it sees the progress,
  // and the first editor to have the page open once the job has finished swaps the card for the image.
  const genApi = '/api/v1/tools';
  const LIVE = ['staged', 'queued', 'running'];
  const POLL_MS = 5000;
  const MAX_REFS = 4;
  const ASPECTS = [['16:9', 'Landscape 16:9'], ['9:16', 'Portrait 9:16'], ['1:1', 'Square 1:1'], ['4:3', 'Classic 4:3'], ['3:4', 'Classic portrait 3:4']];

  window.CodexGenImage = function (ctx) {
    const { $, node, api, announce } = ctx;
    const kit = window.CodexEditorKit;
    let limits = null, allowed = false, pageId = null, pollTimer = 0, polling = false;
    // What the queue said last about each job on the open page; a job not in it yet shows as loading.
    let jobs = new Map(), loaded = false;
    // The open box: the spot it inserts at (carried through edits), its references and the brief last written.
    let box = null;
    const busy = new Set();

    async function gen(path, options) {
      options = options || {};
      const res = await fetch(genApi + path, { method: options.method || 'GET', credentials: 'include',
        headers: options.body !== undefined ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
      let data = null;
      try { data = await res.json(); } catch (_) { /* empty body */ }
      if (!res.ok) {
        const error = new Error(data && (data.error || data.message) || (res.status === 403 ? 'Generating needs a production or tools role.' : 'The generation queue did not answer (' + res.status + ').'));
        error.status = res.status; throw error;
      }
      return data;
    }

    // Only staff who are also generation operators get the button; everyone else never asks the queue. Images already
    // placed on a page still show for every reader.
    const ready = !ctx.staff ? Promise.resolve()
      : gen('/limits').then(l => { limits = l; allowed = !!(l && l.image && l.image.model); }, () => { allowed = false; });

    const editor = () => ctx.editor();
    const imageModel = () => limits.image.model;
    function sizeFor(aspect, resolution) {
      const all = limits.image.sizes || {}, sizes = all[resolution] || all[String(resolution)] || all['1024'] || {};
      const size = sizes[aspect];
      return size ? { width: size[0], height: size[1] } : { width: 1024, height: 1024 };
    }
    const resolutions = () => Object.keys(limits.image.sizes || { 1024: 1 }).map(Number).filter(n => n > 0).sort((a, b) => a - b);

    // ---------- the cards ----------
    function cardsOf(jobId) {
      return Array.from(document.querySelectorAll('#cxEditor .cx-gen')).filter(el => el.dataset.genJob === jobId);
    }
    function findCard(jobId) {
      let found = null;
      editor().state.doc.descendants((n, pos) => {
        if (found) return false;
        if (n.type.name === 'genImage' && n.attrs.jobId === jobId) { found = { node: n, pos }; return false; }
        return true;
      });
      return found;
    }
    function smallButton(label, onClick) {
      const b = node('button', 'btn-ghost', label);
      b.type = 'button';
      b.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); onClick(b); });
      return b;
    }
    function draw(el, attrs) {
      const jobId = attrs.jobId, job = jobs.get(jobId), editable = ctx.canEdit();
      el.textContent = '';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Image being generated');
      const head = node('div', 'cx-gen-head');
      head.append(node('span', 'cx-gen-mark', '✦'), node('span', null, 'Image being generated'));
      el.appendChild(head);
      // Readers see a neutral card; the idea and the controls are the editors'.
      if (editable && attrs.alt) el.appendChild(node('p', 'cx-gen-idea', attrs.alt));
      const state = node('div', 'cx-gen-state');
      const actions = node('div', 'cx-gen-actions');
      if (!job) {
        state.textContent = loaded ? 'This image is no longer being made: its job was deleted.' : 'Asking the queue…';
        if (loaded && editable) actions.appendChild(smallButton('Remove', () => removeCard(jobId)));
      } else if (job.status === 'completed' && job.resultAssetId) {
        if (editable) state.textContent = 'Done. Putting the image here…';
        else {
          const img = node('img', 'cx-gen-result');
          img.src = '/api/codex/assets/' + job.resultAssetId; img.alt = attrs.alt || '';
          state.appendChild(img);
        }
      } else if (job.status === 'running') {
        state.appendChild(node('span', null, job.progressMax > 0 ? 'Rendering ' + job.progressValue + '/' + job.progressMax : 'Rendering'));
        if (job.progressMax > 0) {
          const bar = node('progress'); bar.max = job.progressMax; bar.value = job.progressValue;
          bar.setAttribute('aria-label', 'Render progress'); state.appendChild(bar);
        }
      } else if (job.status === 'queued') {
        state.textContent = job.queuePosition ? 'In queue, position ' + job.queuePosition : 'In queue';
      } else if (job.status === 'staged') {
        state.textContent = job.mine ? 'Waiting in your backlog: your slots are busy.' : 'Waiting in ' + job.createdByName + '’s backlog.';
      } else if (job.status === 'failed') {
        state.classList.add('is-error');
        state.textContent = 'Failed' + (job.error ? ': ' + job.error : '.');
        if (editable && job.mine) actions.appendChild(smallButton('Retry', b => retry(jobId, attrs, b)));
        if (editable) actions.appendChild(smallButton('Remove', () => removeCard(jobId)));
      } else {
        state.textContent = job.status === 'cancelled' ? 'Cancelled.' : job.status;
        if (editable) actions.appendChild(smallButton('Remove', () => removeCard(jobId)));
      }
      if (job && LIVE.includes(job.status) && job.mine && editable) actions.prepend(smallButton('Cancel', b => cancel(jobId, b)));
      if (job && !job.mine && editable && LIVE.includes(job.status)) el.appendChild(node('p', 'cx-gen-by', 'Asked for by ' + job.createdByName));
      if (busy.has(jobId)) actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
      el.appendChild(state);
      if (actions.childNodes.length) el.appendChild(actions);
    }
    function redraw() {
      document.querySelectorAll('#cxEditor .cx-gen').forEach(el => {
        const found = el.dataset.genJob && findCard(el.dataset.genJob);
        draw(el, found ? found.node.attrs : { jobId: el.dataset.genJob, alt: null });
      });
    }
    function mount(el, attrs) {
      draw(el, attrs);
      if (!polling) schedulePoll(0);
    }

    // ---------- keeping them up to date ----------
    function onPage() { return pageId ? kit.genJobIds(editor().state.doc) : []; }
    function schedulePoll(delay) {
      clearTimeout(pollTimer);
      const ids = onPage();
      if (!ids.length) return;
      if (loaded && ids.every(id => jobs.has(id) && !LIVE.includes(jobs.get(id).status) && !(jobs.get(id).status === 'completed' && ctx.canEdit()))) return;
      pollTimer = setTimeout(poll, delay == null ? POLL_MS : delay);
    }
    async function poll() {
      if (!pageId) return;
      if (document.hidden && loaded) { schedulePoll(); return; }
      const id = pageId;
      polling = true;
      try {
        const fresh = await api('/pages/' + id + '/gen-jobs');
        if (id !== pageId) return;
        jobs = new Map(fresh.map(j => [j.jobId, j]));
        loaded = true;
        placeFinished();
        redraw();
      } catch (_) { /* best effort; the next poll tries again */ }
      finally { polling = false; }
      schedulePoll();
    }
    // The finished images go where their cards were; the page saves itself as after any edit.
    function placeFinished() {
      if (!ctx.canEdit() || ctx.isLoading()) return;
      let placed = 0;
      onPage().forEach(jobId => {
        const job = jobs.get(jobId);
        if (!job || job.status !== 'completed' || !job.resultAssetId) return;
        const found = findCard(jobId);
        const alt = found && found.node.attrs.alt || '';
        if (editor().commands.replaceGenImage(jobId, { src: '/api/codex/assets/' + job.resultAssetId, alt, assetId: job.resultAssetId })) placed++;
      });
      if (placed) announce(placed === 1 ? 'A generated image is ready and is now on the page.' : placed + ' generated images are ready and are now on the page.');
    }

    function removeCard(jobId) {
      editor().commands.replaceGenImage(jobId, null);
      announce('Removed the card.');
    }
    async function cancel(jobId, btn) {
      busy.add(jobId); btn.disabled = true;
      try {
        await gen('/jobs/' + jobId, { method: 'DELETE' });
        editor().commands.replaceGenImage(jobId, null);
        announce('Cancelled the image and removed its card.');
      } catch (error) { announce(error.message); ctx.setSave(error.message, true); }
      busy.delete(jobId);
      redraw();
    }
    // Retry sends the failed job again as it was, with a new seed, and points the card at the new job.
    async function retry(jobId, attrs, btn) {
      busy.add(jobId); btn.disabled = true;
      const id = pageId;
      try {
        const old = await gen('/jobs/' + jobId);
        const job = await gen('/jobs', { method: 'POST', body: { model: old.model, mode: old.mode || 'create', prompt: old.prompt,
          width: old.width, height: old.height, resolution: resolutionOf(old),
          refs: (old.refs || []).map(r => ({ rail: r.rail, slot: r.slot, assetId: r.assetId })),
          idea: attrs.alt || undefined, seed: newSeed() } });
        await api('/pages/' + id + '/gen-jobs', { method: 'POST', body: { jobId: job.id } });
        if (id === pageId) {
          jobs.set(job.id, { jobId: job.id, status: job.status, progressValue: 0, progressMax: 0, queuePosition: job.queuePosition, mine: true, createdByName: '' });
          const found = findCard(jobId);
          if (found) editor().view.dispatch(editor().state.tr.setNodeMarkup(found.pos, null, Object.assign({}, found.node.attrs, { jobId: job.id })));
        }
        announce('Sent the image again.');
      } catch (error) { announce(error.message); ctx.setSave(error.message, true); }
      busy.delete(jobId);
      redraw();
      schedulePoll(0);
    }
    function resolutionOf(job) { return Math.max(job.width, job.height) > 1600 ? 2048 : 1024; }
    const newSeed = () => 1 + Math.floor(Math.random() * 2147483000);

    // ---------- the box ----------
    // The images nearest the spot, closest first: the likeliest to show who and what the new one is about.
    function nearestImages(at) {
      const found = [];
      editor().state.doc.descendants((n, pos) => {
        if (n.type.name === 'image' && n.attrs.assetId && !found.some(f => f.assetId === n.attrs.assetId))
          found.push({ assetId: n.attrs.assetId, src: n.attrs.src, alt: n.attrs.alt || '', distance: Math.abs(pos - at) });
        return true;
      });
      const room = Math.min(MAX_REFS, limits.image.maxRefs || MAX_REFS);
      return found.sort((a, b) => a.distance - b.distance).slice(0, room);
    }
    function follow({ transaction }) { if (box) box.spot = transaction.mapping.map(box.spot, 1); }
    async function open() {
      await ready;
      if (!allowed || !ctx.canEdit()) return;
      const spot = editor().state.selection.to;
      box = { pageId, spot, refs: nearestImages(spot).map(r => Object.assign(r, { usable: null, ticked: true })), brief: null };
      editor().on('transaction', follow);
      $('cxGenIdea').value = '';
      $('cxGenPrompt').value = '';
      $('cxGenError').textContent = '';
      $('cxGenStatus').textContent = '';
      fillSizes();
      renderRefs();
      ctx.openBackdrop('cxGenBackdrop', 'cxGenIdea');
      if (box.refs.length) {
        const mine = box;
        try {
          const brief = await api('/pages/' + pageId + '/image-brief', { method: 'POST', body: { idea: '', assetIds: mine.refs.map(r => r.assetId), model: imageModel() } });
          mine.refs.forEach(r => { const said = brief.refs.find(x => x.assetId === r.assetId); r.usable = !!(said && said.usable); if (!r.usable) r.ticked = false; });
        } catch (_) { mine.refs.forEach(r => { r.usable = true; }); }
        if (box === mine) renderRefs();
      }
    }
    function close() {
      editor().off('transaction', follow);
      box = null;
      ctx.closeBackdrop('cxGenBackdrop');
    }
    function fillSizes() {
      const aspect = $('cxGenAspect'), size = $('cxGenSize');
      const offered = Object.keys((limits.image.sizes || {})['1024'] || {});
      aspect.textContent = '';
      ASPECTS.filter(([name]) => !offered.length || offered.includes(name)).forEach(([name, label]) => aspect.appendChild(new Option(label, name, name === '16:9', name === '16:9')));
      size.textContent = '';
      resolutions().forEach(r => size.appendChild(new Option(r >= 2048 ? '2K' : '1K', String(r), r === 1024, r === 1024)));
      size.disabled = size.options.length < 2;
    }
    function renderRefs() {
      const list = $('cxGenRefs');
      list.textContent = '';
      $('cxGenRefsField').hidden = !box.refs.length;
      box.refs.forEach(r => {
        const label = node('label', 'cx-gen-ref' + (r.usable === false ? ' is-off' : ''));
        const tick = node('input'); tick.type = 'checkbox'; tick.checked = r.ticked; tick.disabled = r.usable === false;
        tick.setAttribute('aria-label', 'Use as a reference: ' + (r.alt || 'image'));
        tick.addEventListener('change', () => { r.ticked = tick.checked; box.brief = null; });
        const img = node('img'); img.src = r.src; img.alt = '';
        label.append(tick, img);
        if (r.usable === false) label.title = 'Not usable as a reference: it is not yours and not approved for sharing.';
        list.appendChild(label);
      });
    }
    const tickedRefs = () => box.refs.filter(r => r.ticked && r.usable !== false);
    const genRefs = refs => refs.map((r, slot) => ({ rail: 'image', slot, assetId: r.assetId }));
    function sizeNow() { return sizeFor($('cxGenAspect').value, Number($('cxGenSize').value) || 1024); }
    function setStatus(text, isError) {
      $('cxGenError').textContent = isError ? text : '';
      $('cxGenStatus').textContent = isError ? '' : text;
    }
    function setBusy(on) { ['cxGenWrite', 'cxGenSubmit'].forEach(id => { $(id).disabled = on; }); }

    async function brief(idea) {
      const refs = tickedRefs();
      const said = await api('/pages/' + box.pageId + '/image-brief', { method: 'POST', body: { idea, assetIds: refs.map(r => r.assetId), model: imageModel() } });
      // The server drops what may not be sent; the tags it wrote follow the usable ones in order.
      const usable = refs.filter(r => (said.refs.find(x => x.assetId === r.assetId) || {}).usable);
      return { idea: said.idea, refs: usable };
    }
    async function writePrompt() {
      const idea = $('cxGenIdea').value.trim();
      if (!idea) { setStatus('Say what the image should show first.', true); $('cxGenIdea').focus(); return false; }
      const mine = box;
      setBusy(true);
      setStatus($('cxGenPrompt').value.trim() ? 'Revising the prompt with the story around it…' : 'Writing the prompt from the story around it…');
      try {
        const b = await brief(idea);
        const size = sizeNow();
        const result = await gen('/prompt/advise', { method: 'POST', body: { idea: b.idea, draft: $('cxGenPrompt').value.trim(), width: size.width,
          height: size.height, refs: genRefs(b.refs), model: imageModel(), mode: 'create' } });
        if (box !== mine) return false;
        mine.brief = b;
        $('cxGenPrompt').value = (result.prompt || '').slice(0, 8000);
        setStatus(result.truncated ? 'Prompt written, cut to fit 8000 characters. Edit it freely.' : 'Prompt written. Edit it freely, then Generate.');
        return true;
      } catch (error) { if (box === mine) setStatus(error.message, true); return false; }
      finally { if (box === mine) setBusy(false); }
    }
    async function submit(event) {
      event.preventDefault();
      if (!box) return;
      if (!$('cxGenPrompt').value.trim()) { await writePrompt(); return; }
      const mine = box, idea = $('cxGenIdea').value.trim().slice(0, 500), prompt = $('cxGenPrompt').value.trim();
      setBusy(true); setStatus('Queueing…');
      let job = null;
      try {
        const b = mine.brief || (idea ? await brief(idea) : { idea: '', refs: tickedRefs() });
        const size = sizeNow();
        job = await gen('/jobs', { method: 'POST', body: { model: imageModel(), mode: 'create', prompt, width: size.width, height: size.height,
          resolution: Number($('cxGenSize').value) || 1024, refs: genRefs(b.refs), idea: b.idea || idea || undefined, seed: newSeed() } });
        await api('/pages/' + mine.pageId + '/gen-jobs', { method: 'POST', body: { jobId: job.id } });
      } catch (error) {
        setBusy(false);
        setStatus(job ? 'The image is queued and will land in your gallery, but it could not be placed on the page: ' + error.message : error.message, true);
        return;
      }
      const spot = mine.spot;
      close();
      setBusy(false);
      if (mine.pageId !== pageId || !ctx.canEdit()) { announce('The image is queued and will land in your gallery; you left the page, so it is not placed.'); return; }
      jobs.set(job.id, { jobId: job.id, status: job.status, progressValue: 0, progressMax: 0, queuePosition: job.queuePosition, mine: true, createdByName: '' });
      const at = Math.min(spot, editor().state.doc.content.size);
      editor().chain().focus().insertContentAt(at, { type: 'genImage', attrs: { jobId: job.id, alt: idea || null } }).run();
      announce(job.status === 'staged' ? 'Your slots are busy, so the image waits in your backlog. Its card is on the page.' : 'Queued. The image replaces its card when it is done, and lands in your gallery too.');
      schedulePoll();
    }

    function wire() {
      $('cxGenForm').addEventListener('submit', submit);
      $('cxGenWrite').addEventListener('click', writePrompt);
      $('cxGenCancel').addEventListener('click', close);
      $('cxGenBackdrop').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
      $('cxGenBackdrop').addEventListener('mousedown', event => { if (event.target === $('cxGenBackdrop')) close(); });
    }
    wire();

    return {
      ready,
      allowed: () => allowed,
      mount,
      open,
      // A new page: forget the old one's jobs and ask about this one's.
      setPage(id) {
        clearTimeout(pollTimer);
        pageId = id; jobs = new Map(); loaded = false;
        schedulePoll(0);
      },
      redraw,
    };
  };
})();
