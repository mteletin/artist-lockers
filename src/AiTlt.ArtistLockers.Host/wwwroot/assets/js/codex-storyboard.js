(function () {
  'use strict';
  // The Codex storyboard: shots made from passages of the open page, and the takes made for them.
  // A take is an ordinary job of the generation queue (/api/ed3/h3), submitted by the caller with the caller's own
  // limits and reference rules; the Codex only links the job to the shot. codex.js owns the page and the editor.
  const genApi = '/api/v1/tools';
  // A 'seevio' shot names its model; the Seevio models are listed only for a user with a key (gen-models.js).
  const H3 = 'minimax-h3', SD = 'seedance-2-5', Models = window.MvGenModels;
  const PROVIDERS = { h3: 'H3 video', qwen: 'Qwen image', seevio: 'Seevio video' };
  const LIVE = ['staged', 'queued', 'running'];
  const POLL_MS = 5000;
  const PROMPT_DELAY = 900;
  const statusText = { staged: 'In your backlog', queued: 'Queued', running: 'Rendering', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
  const castTypes = ['character', 'place', 'item', 'faction'];

  window.CodexStoryboard = function (ctx) {
    const Drafts = window.CodexShotPrompts;
    const { $, node, kindChip, announce } = ctx;
    let shots = [], pageId = null, limits = null, limitsError = null, limitsLoading = null, pollTimer = 0, visible = false;
    const queues = new Map(), promptTimers = new Map(), busy = new Set(), notes = new Map();
    // tagFilter shows only the takes with that tag; segmenting is the one take whose segments are open, kept across re-renders.
    let tagFilter = null, segmenting = null;

    const shotPath = shot => '/pages/' + pageId + '/shots/' + shot.id;
    // A page shared to read shows its storyboard without the controls that change it.
    const canEdit = () => ctx.canEdit();
    const kit = window.CodexEditorKit;
    // "With sub-pages" shows the cut of this page and every page inside it; the choice is kept per browser.
    let scope = 'page';
    try { if (localStorage.getItem('codex.boardScope') === 'tree') scope = 'tree'; } catch (_) { /* storage blocked; starts on this page */ }
    const cut = window.CodexCut ? window.CodexCut(Object.assign({}, ctx, {
      changed: () => { if (visible && scope === 'tree') render(); },
      openShot: (id, shotId) => {
        scope = 'page';
        if (id === pageId) { render(); focusCard(shotId); } else ctx.openShot(id, shotId);
      },
    })) : null;
    function descendants() {
      if (!pageId) return 0;
      const all = ctx.pages(), inside = new Set([pageId]);
      let grew = true;
      while (grew) { grew = false; all.forEach(p => { if (p.parentId && inside.has(p.parentId) && !inside.has(p.id)) { inside.add(p.id); grew = true; } }); }
      return inside.size - 1;
    }

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
    function loadLimits() {
      if (limits || limitsError) return Promise.resolve();
      if (!limitsLoading) limitsLoading = gen('/limits').then(l => { limits = l; }, e => { limitsError = e.message; }).finally(() => { limitsLoading = null; if (visible) render(); });
      return limitsLoading;
    }

    // ---------- sizes and lengths, as the studios compute them ----------
    function snap(value, step) { return Math.max(step, Math.round(value / step) * step); }
    function sizeFor(shot) {
      if (shot.provider === 'qwen') {
        const sizes = limits && limits.image && limits.image.sizes && (limits.image.sizes['1024'] || limits.image.sizes[1024]);
        const size = sizes && sizes[shot.aspect];
        return size ? { width: size[0], height: size[1] } : { width: 1024, height: 1024 };
      }
      const w = limits.defaultWidth, h = limits.defaultHeight, step = limits.dimensionStep || 16;
      const long = Math.max(w, h), short = Math.min(w, h);
      if (shot.aspect === '9:16') return { width: short, height: long };
      if (shot.aspect === '1:1') { const side = snap(Math.sqrt(long * short), step); return { width: side, height: side }; }
      return { width: long, height: short };
    }
    function frameOptions() {
      const out = [];
      if (!limits) return out;
      for (let f = limits.minFrames; f <= limits.maxFrames; f += Math.max(1, limits.frameStep)) out.push(f);
      return out;
    }
    function framesFor(shot) {
      const options = frameOptions(), wanted = shot.lengthFrames || limits.defaultLength;
      return options.reduce((best, f) => Math.abs(f - wanted) < Math.abs(best - wanted) ? f : best, options[0] || wanted);
    }
    const seconds = frames => limits && limits.fps > 0 ? (frames / limits.fps).toFixed(1) + ' s' : frames + ' f';
    // A Seevio model renders whole seconds in its own range; the shot keeps them as frames at the queue's fps.
    const cloudModels = () => Models.list(limits, 'video').filter(m => m.provider === 'seevio');
    const cloudSpec = shot => shot.provider === 'seevio' ? Models.find(limits, modelFor(shot)) : null;
    function sdSeconds(shot) {
      const spec = cloudSpec(shot), out = [];
      for (let s = spec ? spec.minSeconds : 4; s <= (spec ? spec.maxSeconds : 15); s++) out.push(s);
      return out;
    }
    function sdSecondsFor(shot) {
      const fps = limits && limits.fps > 0 ? limits.fps : 24, spec = cloudSpec(shot);
      const wanted = shot.lengthFrames ? Math.round(shot.lengthFrames / fps) : 0;
      return spec ? Models.clampSeconds(spec, wanted) : Math.min(15, Math.max(4, wanted || 5));
    }
    const sdFrames = secs => Math.round(secs * (limits && limits.fps > 0 ? limits.fps : 24));
    const hasLength = shot => shot.provider === 'h3' || shot.provider === 'seevio';
    const lengthFor = shot => shot.provider === 'seevio' ? sdFrames(sdSecondsFor(shot)) : framesFor(shot);
    function providerLabel(shot) {
      if (shot.provider !== 'seevio') return PROVIDERS[shot.provider] || PROVIDERS.h3;
      const spec = limits && cloudSpec(shot);
      return (spec ? spec.label : modelFor(shot)) + ' at Seevio';
    }
    function modelFor(shot) {
      return shot.provider === 'qwen' ? (limits.image && limits.image.model) : shot.provider === 'seevio' ? (shot.model || SD) : H3;
    }
    function modelEnabled(shot) {
      const id = modelFor(shot), model = (limits.models || []).find(m => m.id === id);
      // A cloud model is on only when /limits lists it, which it does only for a user with a key.
      if (shot.provider === 'seevio') return !!model && model.enabled;
      return !!id && (!limits.models || !model || model.enabled);
    }
    function maxRefs(shot) {
      if (shot.provider === 'qwen') return limits.image && limits.image.maxRefs || 1;
      if (shot.provider === 'seevio') { const spec = cloudSpec(shot); return spec ? spec.maxImages : 0; }
      return limits.maxImages || 0;
    }

    // ---------- the passage ----------
    function passage(shot) {
      const editor = ctx.editor(), range = kit.shotRanges(editor.state.doc).get(shot.id);
      if (!range) return null;
      return editor.state.doc.textBetween(range.from, range.to, ' ').trim();
    }

    // ---------- saving ----------
    function bodyFor(shot, quote) {
      Drafts.init(shot, modelFor(shot));
      return { version: shot.version, provider: shot.provider, model: shot.provider === 'seevio' ? modelFor(shot) : null,
        prompt: shot.prompt, concept: shot.concept, prompts: shot.prompts, aspect: shot.aspect,
        lengthFrames: hasLength(shot) ? shot.lengthFrames || null : null,
        castPageIds: shot.cast.map(c => c.pageId), refAssetIds: shot.refs.map(r => r.assetId), quote: quote || null };
    }
    // Saves run one at a time per shot, each sending the latest state with the version the last save returned.
    function saveShot(shot, options) {
      options = options || {};
      const run = async () => {
        if (!shots.includes(shot)) return false;
        clearTimeout(promptTimers.get(shot.id)); promptTimers.delete(shot.id);
        try {
          const saved = await ctx.api(shotPath(shot), { method: 'PUT', body: bodyFor(shot, options.quote) });
          shot.version = saved.version; shot.cast = saved.cast; shot.refs = saved.refs; shot.quote = saved.quote;
          shot.pageVersion = saved.pageVersion; shot.updatedAt = saved.updatedAt;
          notes.delete(shot.id);
          if (options.rerender !== false) renderCard(shot);
          return true;
        } catch (error) {
          if (error.status === 409) { announce(error.message); await reload(); return; }
          notes.set(shot.id, { text: 'Not saved: ' + error.message, error: true });
          renderCard(shot);
          return false;
        }
      };
      const next = (queues.get(shot.id) || Promise.resolve()).then(run);
      queues.set(shot.id, next);
      return next;
    }
    function change(shot, apply) {
      if (busy.has(shot.id)) return;
      const previous = modelFor(shot);
      Drafts.init(shot, previous);
      apply(shot);
      if (modelFor(shot) !== previous) Drafts.select(shot, modelFor(shot));
      renderCard(shot); saveShot(shot);
    }

    async function reload() {
      if (!pageId) return;
      const id = pageId;
      try {
        const fresh = await ctx.api('/pages/' + id + '/shots');
        if (id !== pageId) return;
        shots = fresh;
        render(); ctx.refreshBadges();
      } catch (error) { announce(error.message); }
    }

    // ---------- polling live takes ----------
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (!pageId || !shots.some(s => s.takes.some(t => LIVE.includes(t.status)))) return;
      pollTimer = setTimeout(poll, POLL_MS);
    }
    async function poll() {
      if (!pageId) return;
      if (document.hidden) { schedulePoll(); return; }
      const id = pageId;
      try {
        const fresh = await ctx.api('/pages/' + id + '/shots');
        if (id !== pageId) return;
        // Only the takes change here; a card being typed into keeps its fields.
        fresh.forEach(f => {
          const shot = shots.find(s => s.id === f.id);
          if (!shot) return;
          const before = JSON.stringify(shot.takes);
          shot.takes = f.takes;
          if (JSON.stringify(f.takes) !== before && !(segmenting && segmenting.shotId === shot.id)) renderTakes(shot);
        });
      } catch (_) { /* best effort; the next poll tries again */ }
      schedulePoll();
    }

    // ---------- creating a shot from the selection ----------
    async function createFromSelection(info) {
      if (!info || !info.blockId || info.blockType !== 'paragraph') { announce('Select text inside one paragraph.'); return; }
      if (ctx.isDirty() && !(await ctx.save())) { announce('Save the page first.'); return; }
      const editor = ctx.editor(), cast = [];
      editor.state.doc.resolve(info.from).parent.forEach(child => {
        if (child.type.name === 'mention' && ctx.pageById(child.attrs.id) && !cast.includes(child.attrs.id)) cast.push(child.attrs.id);
      });
      const request = { shotId: crypto.randomUUID(), blockId: info.blockId, quote: info.text.slice(0, 4000), castPageIds: cast.slice(0, 12) };
      try {
        const shot = await ctx.api('/pages/' + pageId + '/shots', { method: 'POST', body: request });
        shots.push(shot);
        editor.chain().setShot(shot.id, info.from, info.to).setTextSelection(info.to).run();
        ctx.refreshBadges();
        await ctx.save();
        render();
        announce('Shot ' + shots.length + ' is on the storyboard.');
      } catch (error) { announce(error.message); }
    }

    // ---------- badges in the text ----------
    function badge(shotId) {
      const at = shots.findIndex(s => s.id === shotId);
      if (at < 0) return null;
      const el = node('span', 'cx-badge cx-shot-badge', '🎬 ' + (at + 1));
      el.contentEditable = 'false';
      el.title = 'Shot ' + (at + 1) + ' on the storyboard';
      el.setAttribute('role', 'button');
      el.addEventListener('mousedown', event => event.preventDefault());
      el.addEventListener('click', () => { ctx.showBoard(); focusCard(shotId); });
      return el;
    }
    function focusCard(shotId) {
      const card = document.querySelector('[data-shot-card="' + shotId + '"]');
      if (!card) return;
      card.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash');
    }

    // ---------- rendering ----------
    function render() {
      const board = $('cxBoard');
      if (!board) return;
      $('cxShotCount').textContent = shots.length ? String(shots.length) : '';
      scheduleCoverage();
      if (!visible) return;
      const inside = descendants();
      if (scope === 'tree' && inside > 0 && cut) {
        // The cut is built once per load and kept, so polls and edits do not stop it mid-play.
        const view = cut.view(pageId);
        if (view.parentNode === board) return;
        board.textContent = '';
        board.append(boardHead(inside, 'The shots of this page and the ' + inside + (inside === 1 ? ' page' : ' pages') + ' inside it, in the tree’s order. Reorder shots on each page.'), view);
        return;
      }
      if (cut) cut.stop();
      board.textContent = '';
      board.appendChild(boardHead(inside, !canEdit() ? 'This page is shared with you to read only.'
        : shots.length ? 'Shots follow the order below. Drag a card, or use ↑ and ↓, to change it.' : ''));
      const tags = pageTags();
      if (tagFilter && !tags.includes(tagFilter)) tagFilter = null;
      if (tags.length) board.appendChild(tagFilterRow(tags));
      const suggestions = node('datalist'); suggestions.id = 'cxTagSuggestions';
      tags.forEach(t => suggestions.appendChild(new Option(t)));
      board.appendChild(suggestions);
      if (limitsError) board.appendChild(node('p', 'cx-board-note is-warn', 'Takes cannot be made from this account: ' + limitsError));
      if (!pageId) {
        board.appendChild(node('p', 'cx-panel-empty', 'Each page has its own storyboard. Create a page in Write, write a scene, then select text inside a paragraph and choose 🎬 Shot.'));
        return;
      }
      board.appendChild(summaryBox());
      if (!shots.length) {
        board.appendChild(node('p', 'cx-panel-empty', canEdit() ? 'No shots yet. In Write, select text inside a paragraph and choose 🎬 Shot.' : 'No shots yet.'));
        return;
      }
      const list = node('ol', 'cx-shots');
      shots.forEach(shot => list.appendChild(node('li')));
      board.appendChild(list);
      shots.forEach(renderCard);
      schedulePoll();
    }
    function boardHead(inside, help) {
      const head = node('div', 'cx-board-head');
      head.appendChild(node('h2', 'cx-board-title', 'Storyboard'));
      if (inside > 0 && cut) {
        const seg = node('div', 'cx-seg cx-board-scope');
        seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Show');
        [['page', 'This page'], ['tree', 'With sub-pages (' + inside + ')']].forEach(([value, label]) => {
          const b = button(label, () => {
            if (scope === value) return;
            scope = value;
            try { localStorage.setItem('codex.boardScope', value); } catch (_) { /* per-browser convenience only */ }
            if (value === 'tree') cut.reset();
            render();
          });
          b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(scope === value));
          seg.appendChild(b);
        });
        head.appendChild(seg);
      }
      // Export what is on screen: this page's shots, or the whole cut with its sub-pages.
      const whole = scope === 'tree' && inside > 0;
      if (cut && canEdit() && (whole || shots.length)) head.appendChild(cut.exporter(pageId, whole));
      if (help) head.appendChild(node('p', 'cx-help', help));
      return head;
    }
    function pageTags() {
      const all = new Set();
      shots.forEach(s => s.takes.forEach(t => (t.tags || []).forEach(tag => all.add(tag))));
      return [...all].sort();
    }
    function tagFilterRow(tags) {
      const row = node('div', 'cx-shot-row cx-tag-filter');
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Show takes tagged');
      row.appendChild(fieldLabel('Show'));
      [null].concat(tags).forEach(tag => {
        const count = tag && shots.reduce((n, s) => n + s.takes.filter(t => t.tags.includes(tag)).length, 0);
        const b = button(tag ? '#' + tag + ' ' + count : 'All takes', () => { tagFilter = tag; render(); });
        b.className = 'cx-tag'; b.setAttribute('aria-pressed', String(tagFilter === tag));
        row.appendChild(b);
      });
      return row;
    }
    function slotFor(shot) {
      const list = document.querySelector('#cxBoard .cx-shots');
      const at = shots.indexOf(shot);
      return list && at >= 0 ? list.children[at] : null;
    }
    function renderCard(shot) {
      const slot = visible && slotFor(shot);
      if (!slot) return;
      const at = shots.indexOf(shot), card = node('article', 'cx-shot-card');
      card.dataset.shotCard = shot.id;
      card.setAttribute('aria-label', 'Shot ' + (at + 1));
      const editable = canEdit();
      if (editable) wireDrag(card, shot);

      const head = node('div', 'cx-shot-head');
      if (editable) {
        const grip = node('span', 'cx-grip', '⠿'); grip.title = 'Drag to reorder'; grip.setAttribute('aria-hidden', 'true');
        head.appendChild(grip);
      }
      head.append(node('span', 'cx-shot-no', 'Shot ' + (at + 1)), node('span', 'cx-shot-by', 'by ' + shot.createdByName));
      if (editable) {
        const up = button('↑', () => move(shot, -1), 'Move shot ' + (at + 1) + ' up'); up.disabled = at === 0;
        const down = button('↓', () => move(shot, 1), 'Move shot ' + (at + 1) + ' down'); down.disabled = at === shots.length - 1;
        const remove = button('Delete', () => deleteShot(shot), 'Delete shot ' + (at + 1)); remove.classList.add('is-danger');
        head.append(up, down, remove);
      }

      const quote = node('blockquote', 'cx-quote', shot.quote);
      const actions = node('div', 'cx-card-actions');
      const current = passage(shot);
      if (current !== null) actions.appendChild(button('↩ Show passage', () => { ctx.showWrite(); ctx.flash({ shotId: shot.id }); }));
      card.append(head, quote);
      if (current === null) card.appendChild(node('p', 'cx-board-note is-warn', 'The marker was removed from the text. This shot stays here until you delete it.'));
      else if (current !== shot.quote) {
        const warn = node('div', 'cx-board-note is-warn');
        warn.appendChild(node('span', null, 'The passage changed since this shot was made. It now reads: “' + current + '”. '));
        if (editable) warn.appendChild(button('Use current text', () => saveShot(shot, { quote: current.slice(0, 4000) })));
        card.appendChild(warn);
      }
      if (actions.childNodes.length) card.appendChild(actions);

      card.append(castRow(shot), editable ? settingsRow(shot) : settingsText(shot), refsRow(shot), conceptBlock(shot), promptBlock(shot));
      const takes = node('div', 'cx-takes'); takes.dataset.takes = shot.id;
      card.appendChild(takes);
      slot.textContent = '';
      slot.appendChild(card);
      renderTakes(shot);
    }
    function button(label, onClick, aria) {
      const b = node('button', null, label); b.type = 'button';
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      return b;
    }
    function fieldLabel(text) { return node('span', 'cx-shot-label', text); }

    function castRow(shot) {
      const row = node('div', 'cx-shot-row');
      const chips = node('div', 'cx-chips');
      shot.cast.forEach(c => {
        const chip = node('span', 'cx-chip');
        chip.append(kindChip(c.pageType), document.createTextNode(c.title));
        if (canEdit()) {
          const x = button('×', () => change(shot, s => { s.cast = s.cast.filter(o => o.pageId !== c.pageId); }), 'Remove ' + c.title);
          x.className = 'cx-chip-x';
          chip.appendChild(x);
        }
        chips.appendChild(chip);
      });
      if (!canEdit() && !shot.cast.length) chips.appendChild(node('span', 'cx-shot-by', 'Nobody named yet'));
      if (canEdit() && shot.cast.length < 12) {
        const add = node('select', 'cx-shot-select');
        add.setAttribute('aria-label', 'Add to the cast');
        add.appendChild(new Option('+ Cast…', ''));
        const taken = new Set(shot.cast.map(c => c.pageId));
        const choices = ctx.pages().filter(p => !taken.has(p.id) && p.id !== pageId)
          .sort((a, b) => (castTypes.includes(b.pageType) - castTypes.includes(a.pageType)) || a.title.localeCompare(b.title));
        choices.forEach(p => add.appendChild(new Option(p.title, p.id)));
        add.addEventListener('change', () => {
          const page = ctx.pageById(add.value);
          if (page) change(shot, s => { s.cast = s.cast.concat({ pageId: page.id, title: page.title, pageType: page.pageType, summary: '' }); });
        });
        chips.appendChild(add);
      }
      row.append(fieldLabel('Cast'), chips);
      return row;
    }

    function settingsRow(shot) {
      const row = node('div', 'cx-shot-row');
      const seg = node('div', 'cx-seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Provider');
      const offered = [['h3', PROVIDERS.h3], ['qwen', PROVIDERS.qwen]];
      if (shot.provider === 'seevio' || (limits && cloudModels().length)) offered.push(['seevio', PROVIDERS.seevio]);
      offered.forEach(([value, label]) => {
        const b = button(label, () => {
          if (shot.provider === value) return;
          change(shot, s => {
            s.provider = value;
            if (value === 'seevio' && !s.model) s.model = (cloudModels()[0] || { id: SD }).id;
          });
        });
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(shot.provider === value));
        seg.appendChild(b);
      });
      const aspect = node('select', 'cx-shot-select'); aspect.setAttribute('aria-label', 'Aspect');
      ['16:9', '9:16', '1:1'].forEach(a => aspect.appendChild(new Option(a, a)));
      aspect.value = shot.aspect;
      aspect.addEventListener('change', () => change(shot, s => { s.aspect = aspect.value; }));
      row.append(fieldLabel('Make'), seg, aspect);
      if (shot.provider === 'h3' && limits) {
        const length = node('select', 'cx-shot-select'); length.setAttribute('aria-label', 'Length');
        frameOptions().forEach(f => length.appendChild(new Option(seconds(f), String(f))));
        length.value = String(framesFor(shot));
        length.addEventListener('change', () => change(shot, s => { s.lengthFrames = Number(length.value); }));
        row.appendChild(length);
      }
      if (shot.provider === 'seevio' && limits) {
        const model = node('select', 'cx-shot-select'); model.setAttribute('aria-label', 'Model');
        const listed = cloudModels();
        listed.forEach(m => model.appendChild(new Option(m.label, m.id)));
        if (!listed.some(m => m.id === modelFor(shot))) model.appendChild(new Option(modelFor(shot) + ' (needs your key)', modelFor(shot)));
        model.value = modelFor(shot);
        model.addEventListener('change', () => change(shot, s => { s.model = model.value; }));
        row.appendChild(model);
        const length = node('select', 'cx-shot-select'); length.setAttribute('aria-label', 'Length');
        sdSeconds(shot).forEach(secs => length.appendChild(new Option(secs + ' s', String(secs))));
        length.value = String(sdSecondsFor(shot));
        length.addEventListener('change', () => change(shot, s => { s.lengthFrames = sdFrames(Number(length.value)); }));
        row.appendChild(length);
      }
      return row;
    }

    function settingsText(shot) {
      const row = node('div', 'cx-shot-row');
      const parts = [providerLabel(shot), shot.aspect];
      if (hasLength(shot) && shot.lengthFrames) parts.push(seconds(shot.lengthFrames));
      row.append(fieldLabel('Make'), node('span', 'cx-shot-by', parts.join(' · ')));
      return row;
    }

    function refsRow(shot) {
      const row = node('div', 'cx-shot-row');
      const list = node('div', 'cx-refs');
      shot.refs.forEach((r, i) => {
        const tile = node('figure', 'cx-ref' + (r.usable ? '' : ' is-warn'));
        const img = node('img'); img.src = '/api/codex/assets/' + r.assetId; img.alt = r.filename; img.loading = 'lazy';
        img.addEventListener('error', () => { img.replaceWith(node('span', 'cx-ref-missing', r.filename)); });
        tile.append(img, node('figcaption', null, shot.provider === 'seevio' ? 'Image ' + (i + 1) : '<Picture ' + (i + 1) + '>'));
        if (canEdit()) {
          const x = button('×', () => change(shot, s => { s.refs = s.refs.filter((_, j) => j !== i); }), 'Remove reference ' + (i + 1));
          x.className = 'cx-chip-x';
          tile.appendChild(x);
        }
        if (!r.usable) tile.title = 'Not shared: its owner must share it before you can use it.';
        list.appendChild(tile);
      });
      if (!canEdit() && !shot.refs.length) list.appendChild(node('span', 'cx-shot-by', 'None'));
      if (canEdit() && shot.refs.length < 9) {
        const add = button('+ Image', () => window.MobvisionAssetPicker.open({ source: '/api/codex/gallery', title: 'Reference image', kind: 'image', onPick: (url, asset) => {
          if (!asset || !asset.id || shot.refs.some(r => r.assetId === asset.id)) return;
          change(shot, s => { s.refs = s.refs.concat({ assetId: asset.id, filename: asset.filename || 'image', usable: true }); });
        } }));
        add.className = 'cx-ref-add';
        list.appendChild(add);
      }
      row.append(fieldLabel('References'), list);
      if (canEdit() && shot.refs.some(r => !r.usable)) row.appendChild(node('p', 'cx-board-note is-warn', 'A reference is someone else’s and is not shared. Ask its owner to share it first, or remove it.'));
      return row;
    }

    function conceptBlock(shot) {
      Drafts.init(shot, modelFor(shot));
      const wrap = node('div', 'cx-shot-prompt');
      const label = node('label', 'cx-shot-label', '1. Concept'); label.htmlFor = 'cxConcept-' + shot.id;
      const text = node('textarea'); text.id = label.htmlFor; text.rows = 3; text.maxLength = 8000; text.value = shot.concept;
      text.placeholder = 'What happens, who is there, mood, camera intent and dialogue. This stays the same when you change models.';
      text.readOnly = !canEdit() || busy.has(shot.id);
      text.addEventListener('input', () => {
        shot.concept = text.value;
        const card = text.closest('.cx-shot-card');
        const make = card && card.querySelector('[data-generate]');
        if (make) {
          make.disabled = !shot.prompt.trim() || !!blocker(shot) || busy.has(shot.id) || Drafts.stale(shot, modelFor(shot));
          make.title = Drafts.stale(shot, modelFor(shot)) ? 'Concept changed. Prepare this model’s prompt again, or edit it to match.' : blocker(shot) || '';
        }
        const status = card && card.querySelector('.cx-shot-status');
        if (status) status.textContent = Drafts.stale(shot, modelFor(shot)) ? 'Concept changed. Prepare this model’s prompt again, or edit it to match.' : '';
        clearTimeout(promptTimers.get(shot.id));
        promptTimers.set(shot.id, setTimeout(() => saveShot(shot, { rerender: false }), PROMPT_DELAY));
      });
      wrap.append(label, text);
      if (canEdit()) {
        const use = button('Use passage as concept', () => change(shot, s => { s.concept = s.quote; }));
        use.className = 'btn-ghost'; wrap.appendChild(use);
      }
      return wrap;
    }
    function promptBlock(shot) {
      const draft = Drafts.init(shot, modelFor(shot));
      const wrap = node('div', 'cx-shot-prompt');
      const id = 'cxPrompt-' + shot.id;
      const label = node('label', 'cx-shot-label', '2. Render prompt · ' + providerLabel(shot)); label.htmlFor = id;
      const text = node('textarea'); text.id = id; text.rows = 5; text.maxLength = 8000; text.value = shot.prompt;
      text.placeholder = 'Prepare a prompt for this model from the concept, passage, cast and references.';
      if (draft?.language === 'zh') text.maxLength = 1800;
      if (shot.provider === 'seevio' && draft?.promptZh) {
        const language = node('select', 'cx-shot-select'); language.setAttribute('aria-label', 'Render prompt language');
        language.append(new Option('English', 'en'), new Option('Chinese', 'zh')); language.value = draft.language || 'en';
        language.disabled = !canEdit() || busy.has(shot.id);
        language.addEventListener('change', () => change(shot, s => {
          s.prompts[modelFor(s)].language = language.value; Drafts.select(s, modelFor(s));
        }));
        wrap.appendChild(language);
      }
      if (!canEdit()) {
        text.readOnly = true; text.placeholder = 'No prompt yet.';
        wrap.append(label, text);
        return wrap;
      }
      text.addEventListener('input', () => {
        Drafts.edit(shot, modelFor(shot), text.value);
        const make = wrap.querySelector('[data-generate]');
        if (make) { make.disabled = !shot.prompt.trim() || !!blocker(shot) || busy.has(shot.id); make.title = blocker(shot) || ''; }
        status.textContent = ''; status.classList.remove('is-error');
        clearTimeout(promptTimers.get(shot.id));
        promptTimers.set(shot.id, setTimeout(() => saveShot(shot, { rerender: false }), PROMPT_DELAY));
      });
      const row = node('div', 'cx-row');
      const status = node('p', 'cx-shot-status');
      status.setAttribute('role', 'status');
      const note = notes.get(shot.id);
      if (note) { status.textContent = note.text; status.classList.toggle('is-error', !!note.error); }
      const advise = button('✦ Prepare ' + providerLabel(shot) + ' prompt', () => runAdvise(shot, text, status, advise));
      advise.className = 'btn-ghost';
      const make = button(shot.provider === 'qwen' ? 'Generate image take' : 'Generate video take', () => runGenerate(shot, text, status, make));
      make.className = 'btn-primary';
      make.dataset.generate = '';
      if (!shot.prompt.trim()) { make.disabled = true; make.title = 'Prepare this model’s prompt first, or write one.'; }
      const block = blocker(shot);
      if (block) { make.disabled = true; make.title = block; advise.disabled = !limits; }
      if (Drafts.stale(shot, modelFor(shot))) {
        make.disabled = true; make.title = 'Concept changed. Prepare this model’s prompt again, or edit it to match.';
        status.textContent = make.title;
      }
      if (busy.has(shot.id)) { make.disabled = true; advise.disabled = true; }
      row.append(advise, make);
      wrap.append(label, text, row, status);
      return wrap;
    }
    function blocker(shot) {
      if (limitsError) return limitsError;
      if (!limits) return 'Loading the queue’s limits…';
      if (!modelEnabled(shot)) return shot.provider === 'seevio'
        ? 'Enable your default Seevio key under Tools → AI zone to render on ' + providerLabel(shot) + '.'
        : providerLabel(shot) + ' is switched off right now.';
      if (shot.refs.some(r => !r.usable)) return 'A reference is not shared with you.';
      if (shot.refs.length > maxRefs(shot)) return 'This model takes at most ' + maxRefs(shot) + ' reference image(s).';
      return null;
    }
    function genRefs(shot) { return shot.refs.map((r, slot) => ({ rail: 'image', slot, assetId: r.assetId })); }
    function idea(shot, ceiling) {
      ceiling = ceiling || 4000;
      const title = (ctx.pageById(pageId) || {}).title || '';
      let text = shot.concept.trim() ? 'Shot concept (the intent to preserve):\n' + shot.concept.trim() + '\n\n' : '';
      text += 'A shot from the story page “' + title + '”.';
      if (shot.cast.length) {
        text += '\n\nWho and what is in it:';
        const room = Math.max(120, Math.floor((ceiling - 100 - text.length) / shot.cast.length) - 40);
        shot.cast.forEach(c => { text += '\n- ' + c.title + ' (' + c.pageType + ')' + (c.summary ? ': ' + c.summary.replace(/\s+/g, ' ').slice(0, room) : ''); });
      }
      if (shot.refs.length) text += '\n\nAttached reference images in upload order: ' + shot.refs.map((r, i) => shot.provider === 'seevio' ? Models.tagFor({ advisor: 'seedance' }, 'image', i) : '<Picture ' + (i + 1) + '>').join(', ') + '.';
      text += '\n\nThe passage (context, not additional action to invent):\n“' + shot.quote + '”';
      return text.slice(0, ceiling);
    }
    async function runAdvise(shot, text, status, btn) {
      if (!limits || busy.has(shot.id)) return;
      Drafts.init(shot, modelFor(shot));
      const selectedModel = modelFor(shot), concept = shot.concept, original = shot.prompt;
      busy.add(shot.id); btn.disabled = true; status.classList.remove('is-error');
      status.textContent = shot.prompt.trim() ? 'Revising the prompt…' : 'Writing the prompt…';
      const size = sizeFor(shot);
      try {
        await (queues.get(shot.id) || Promise.resolve());
        const result = await gen('/prompt/advise', { method: 'POST', body: { idea: idea(shot, 12000), draft: shot.prompt.trim(), width: size.width, height: size.height,
          length: hasLength(shot) ? lengthFor(shot) : undefined, seconds: shot.provider === 'seevio' ? sdSecondsFor(shot) : undefined,
          refs: genRefs(shot), model: modelFor(shot), mode: shot.provider === 'qwen' ? 'create' : undefined } });
        if (modelFor(shot) !== selectedModel || shot.concept !== concept || shot.prompt !== original)
          throw new Error('The concept or draft changed while preparing. Your edits were kept; prepare again.');
        Drafts.prepare(shot, selectedModel, (result.prompt || '').slice(0, 8000), result.promptZh, concept);
        if (text.isConnected) text.value = shot.prompt;
        if (!await saveShot(shot, { rerender: false })) throw new Error('Prompt prepared, but saving failed. Retry saving before rendering.');
        notes.set(shot.id, { text: result.truncated ? 'Prompt written, cut to fit 8000 characters.' : 'Prompt written. Edit it freely.' });
      } catch (error) { notes.set(shot.id, { text: error.message, error: true }); }
      busy.delete(shot.id);
      renderCard(shot);
    }
    async function runGenerate(shot, text, status, btn) {
      if (busy.has(shot.id)) return;
      const block = blocker(shot);
      if (block) { notes.set(shot.id, { text: block, error: true }); renderCard(shot); return; }
      if (Drafts.stale(shot, modelFor(shot))) { notes.set(shot.id, { text: 'Concept changed. Prepare this model’s prompt again, or edit it to match.', error: true }); renderCard(shot); return; }
      const prompt = shot.prompt.trim();
      const selectedModel = modelFor(shot), concept = shot.concept;
      if (!prompt) { status.textContent = 'Prepare this model’s prompt first, or write one.'; status.classList.add('is-error'); text.focus(); return; }
      busy.add(shot.id); btn.disabled = true; status.classList.remove('is-error'); status.textContent = 'Queueing…';
      const size = sizeFor(shot);
      const body = shot.provider === 'qwen'
        ? { model: modelFor(shot), mode: 'create', prompt, width: size.width, height: size.height, resolution: 1024, refs: genRefs(shot),
            idea: idea(shot), seed: 1 + Math.floor(Math.random() * 2147483000) }
        : shot.provider === 'seevio'
          ? { model: modelFor(shot), prompt, seconds: sdSecondsFor(shot), aspect: shot.aspect, width: size.width, height: size.height,
              refs: genRefs(shot), idea: idea(shot) }
          : { model: modelFor(shot), prompt, width: size.width, height: size.height, length: lengthFor(shot), refs: genRefs(shot), idea: idea(shot) };
      let job = null;
      try {
        if (!await saveShot(shot, { rerender: false })) throw new Error('The shot could not be saved. Try again before rendering.');
        if (modelFor(shot) !== selectedModel || shot.concept !== concept || shot.prompt.trim() !== prompt)
          throw new Error('The concept or draft changed before submission. Review it and generate again.');
        job = await gen('/jobs', { method: 'POST', body });
        const saved = await ctx.api(shotPath(shot) + '/takes', { method: 'POST', body: { jobId: job.id } });
        shot.takes = saved.takes;
        notes.set(shot.id, { text: job.status === 'staged' ? 'Your slots are busy, so the take waits in your backlog.' : 'Queued. The result also lands in your gallery.' });
      } catch (error) {
        notes.set(shot.id, { text: job ? 'The job is queued in your gallery, but linking it to the shot failed: ' + error.message : error.message, error: true });
      }
      busy.delete(shot.id);
      renderCard(shot);
      schedulePoll();
    }

    function renderTakes(shot) {
      scheduleCoverage();
      const box = document.querySelector('[data-takes="' + shot.id + '"]');
      if (!box) return;
      box.textContent = '';
      if (!shot.takes.length) { box.appendChild(node('p', 'cx-panel-empty', 'No takes yet.')); return; }
      box.appendChild(fieldLabel('Takes'));
      const shown = tagFilter ? shot.takes.filter(t => t.tags.includes(tagFilter)) : shot.takes;
      if (!shown.length) { box.appendChild(node('p', 'cx-panel-empty', 'No takes tagged #' + tagFilter + ' on this shot.')); return; }
      const strip = node('div', 'cx-take-strip');
      shown.slice().reverse().forEach(take => {
        const tile = node('figure', 'cx-take' + (take.verdict ? ' is-' + take.verdict : ''));
        if (take.hasResult && take.status === 'completed') {
          const src = '/api/codex/takes/' + take.id + '/media';
          let media;
          if (take.kind === 'image') { media = node('img'); media.alt = 'Take by ' + take.createdByName; }
          else { media = node('video'); media.controls = true; media.preload = 'metadata'; media.playsInline = true; playOnly(media, () => trimSpan(take)); }
          media.src = src; media.className = 'cx-take-media';
          tile.appendChild(media);
        } else {
          const state = node('div', 'cx-take-state');
          state.appendChild(node('span', null, statusText[take.status] || take.status));
          if (take.status === 'running' && take.progressMax > 0) {
            const bar = node('progress'); bar.max = take.progressMax; bar.value = take.progressValue;
            bar.setAttribute('aria-label', 'Render progress'); state.appendChild(bar);
          }
          if (take.error) state.appendChild(node('small', null, take.error));
          tile.appendChild(state);
        }
        const cap = node('figcaption');
        cap.appendChild(node('span', 'cx-take-by', take.createdByName + ' · ' + ctx.timeLabel(take.createdAt)));
        if (take.quote !== shot.quote) cap.appendChild(node('span', 'cx-take-flag', 'Text changed since this take'));
        const span = trimSpan(take);
        if (span) cap.appendChild(node('span', 'cx-take-trim', '✂ ' + (take.segmentLabel ? take.segmentLabel + ' · ' : '')
          + span.start.toFixed(2) + '–' + span.end.toFixed(2) + ' s'));
        cap.appendChild(tagsRow(shot, take));
        if (!canEdit()) {
          if (take.verdict) cap.appendChild(node('span', 'cx-take-flag', take.verdict === 'keep' ? 'Kept' : 'Rejected'));
          tile.appendChild(cap);
          strip.appendChild(tile);
          return;
        }
        const actions = node('div', 'cx-card-actions');
        [['keep', 'Keep'], ['reject', 'Reject']].forEach(([value, label]) => {
          const b = button(label, () => verdict(shot, take, take.verdict === value ? null : value));
          b.setAttribute('aria-pressed', String(take.verdict === value));
          actions.appendChild(b);
        });
        if (take.kind === 'video' && take.hasResult && take.status === 'completed') {
          const parts = button('Segments', () => openSegments(shot, take), 'Segments of this take');
          parts.setAttribute('aria-pressed', String(!!(segmenting && segmenting.takeId === take.id)));
          actions.appendChild(parts);
        }
        const unlink = button('Unlink', () => unlinkTake(shot, take)); unlink.classList.add('is-danger');
        actions.appendChild(unlink);
        cap.appendChild(actions);
        tile.appendChild(cap);
        strip.appendChild(tile);
      });
      box.appendChild(strip);
      const open = segmenting && segmenting.shotId === shot.id && shot.takes.find(t => t.id === segmenting.takeId);
      if (open) box.appendChild(segmentPanel(shot, open));
    }

    // ---------- tags ----------
    function tagsRow(shot, take) {
      const row = node('div', 'cx-take-tags');
      take.tags.forEach(tag => {
        const chip = node('span', 'cx-tag', '#' + tag);
        if (canEdit()) {
          const x = button('×', () => saveTags(shot, take, take.tags.filter(t => t !== tag)), 'Remove tag ' + tag);
          x.className = 'cx-chip-x';
          chip.appendChild(x);
        }
        row.appendChild(chip);
      });
      if (canEdit() && take.tags.length < 8) {
        const input = node('input', 'cx-tag-input');
        input.type = 'text'; input.maxLength = 33; input.placeholder = '+ tag';
        input.setAttribute('list', 'cxTagSuggestions'); input.setAttribute('aria-label', 'Add a tag to this take');
        let sent = false;
        const add = () => { const value = input.value.trim(); if (value && !sent) { sent = true; saveTags(shot, take, take.tags.concat(value)); } };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
        input.addEventListener('change', add);
        row.appendChild(input);
      }
      return row;
    }
    async function saveTags(shot, take, tags) {
      try {
        const saved = await ctx.api(shotPath(shot) + '/takes/' + take.id + '/tags', { method: 'PUT', body: { tags } });
        shot.takes = saved.takes;
        // The filter row and the suggestions list cover the whole page, so the board is drawn again.
        render();
      } catch (error) { announce(error.message); renderTakes(shot); }
    }

    // ---------- segments ----------
    // A segment is a part of a video: a first and a last frame, both played; the file is never cut. Segments belong to the
    // video, so every shot with it as a take sees them, and each take plays one segment or the whole video.
    // The scrubber is the gallery's frame tool (account-gen-shared.js frameTool): a coarse slider across the clip and a
    // fine one of ±60 frames around it.
    const FINE_SPAN = 60;
    function trimSpan(take) {
      return take.trimFps > 0 && take.trimIn !== null && take.trimOut !== null
        ? { start: take.trimIn / take.trimFps, end: (take.trimOut + 1) / take.trimFps } : null;
    }
    // Keeps a player inside a span: playing starts at its beginning and stops back there at its end.
    function playOnly(video, span) {
      let watching = false;
      const watch = () => {
        const r = span();
        if (!r || video.paused || video.ended) { watching = false; return; }
        if (video.currentTime >= r.end - 0.005) { video.pause(); video.currentTime = r.start; watching = false; return; }
        requestAnimationFrame(watch);
      };
      video.addEventListener('loadedmetadata', () => { const r = span(); if (r) video.currentTime = r.start; });
      video.addEventListener('play', () => {
        const r = span();
        if (!r) return;
        if (video.currentTime < r.start - 0.005 || video.currentTime >= r.end - 0.005) video.currentTime = r.start;
        if (!watching) { watching = true; requestAnimationFrame(watch); }
      });
    }
    const segmentName = (segment, n) => segment.label || 'Segment ' + (n + 1);
    const shotsWord = n => n === 1 ? '1 shot' : n + ' shots';
    function takePath(shot, take) { return shotPath(shot) + '/takes/' + take.id; }

    function openSegments(shot, take) {
      const previous = segmenting && shots.find(s => s.id === segmenting.shotId);
      segmenting = segmenting && segmenting.takeId === take.id ? null
        : { shotId: shot.id, takeId: take.id, info: null, error: null, segments: null, base: 0, fine: 0, in: 0, out: 0, editing: null, label: '' };
      if (previous && previous !== shot) renderTakes(previous);
      renderTakes(shot);
      if (!segmenting) return;
      const state = segmenting;
      Promise.all([ctx.api(takePath(shot, take) + '/frames'), ctx.api(takePath(shot, take) + '/segments')]).then(([info, segments]) => {
        if (!(info && info.fps > 0 && info.frameCount > 1)) throw new Error('This take’s frames could not be read, so segments cannot be marked on it.');
        state.info = info; state.segments = segments;
        const playing = take.segmentId && segments.find(g => g.id === take.segmentId);
        state.in = playing ? Math.min(playing.inFrame, info.lastFrame - 1) : 0;
        state.out = playing ? Math.min(playing.outFrame, info.lastFrame) : info.lastFrame;
        state.base = state.in;
      }).catch(error => { state.error = error.message; })
        .then(() => { if (segmenting === state) renderTakes(shot); });
    }
    function segmentPanel(shot, take) {
      const state = segmenting, panel = node('div', 'cx-trim cx-seg');
      panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Segments of the take by ' + take.createdByName);
      const head = node('div', 'cx-trim-head');
      head.append(fieldLabel('Segments'), node('span', 'cx-shot-by',
        'Mark the parts of this video. Each shot plays one segment, or the whole video. The file itself is not cut.'));
      panel.appendChild(head);
      if (state.error) { panel.append(node('p', 'cx-board-note is-warn', state.error), closeRow()); return panel; }
      if (!state.info) { panel.appendChild(node('p', 'cx-panel-empty', 'Reading frames…')); return panel; }
      const fps = state.info.fps, last = state.info.lastFrame;
      const at = frame => (frame / fps).toFixed(2) + ' s';
      const clamp = frame => Math.max(0, Math.min(last, frame));
      const current = () => clamp(state.base + state.fine);
      const video = node('video', 'cx-trim-video'); video.preload = 'auto'; video.playsInline = true; video.controls = true;
      video.src = '/api/codex/takes/' + take.id + '/media';
      // A span while ▶ plays a segment or the In–Out; the player's own play button plays the whole file.
      let playing = null, playingButton = null, lastOwnSeek = 0;
      // The middle of the frame's interval, so rounding in the decoder cannot land on a neighbour.
      const seek = () => {
        const end = isFinite(video.duration) && video.duration > 0 ? video.duration - 0.001 : Infinity;
        lastOwnSeek = Date.now();
        try { if (!video.paused) video.pause(); video.currentTime = Math.min((current() + 0.5) / fps, end); } catch (_) { /* not seekable yet; loadedmetadata seeks */ }
      };
      playOnly(video, () => playing);
      video.addEventListener('loadedmetadata', seek);
      function stopped() {
        if (!playing) return;
        playing = null;
        if (playingButton) { playingButton.textContent = playingButton.dataset.idle; playingButton = null; }
        seek();
      }
      // Scrubbing or pausing the player itself moves the selection to the playhead.
      function followPlayhead() {
        if (playing || Date.now() - lastOwnSeek < 400) return;
        const frame = clamp(Math.floor(video.currentTime * fps + 1e-6));
        if (frame === current()) return;
        state.base = frame; state.fine = 0; update();
      }
      video.addEventListener('pause', () => { if (playing) stopped(); else followPlayhead(); });
      video.addEventListener('seeked', followPlayhead);
      function playSpan(from, to, trigger) {
        if (playing && playingButton === trigger) { video.pause(); return; }
        // Switching spans keeps the player running; a pause here would land after the switch and stop the new one.
        if (playingButton) playingButton.textContent = playingButton.dataset.idle;
        playing = { start: from / fps, end: (to + 1) / fps };
        playingButton = trigger;
        if (trigger) { trigger.dataset.idle = trigger.dataset.idle || trigger.textContent; trigger.textContent = '■ Stop'; }
        video.currentTime = playing.start;
        if (video.paused) video.play().catch(() => stopped());
      }

      const readout = node('span', 'cx-trim-readout');
      readout.setAttribute('aria-live', 'off');
      // Every segment as a band over the clip, the one being marked on top; a band opens its segment for editing.
      const strip = node('div', 'cx-seg-strip');
      const draft = node('span', 'cx-seg-band is-draft');
      const head_ = node('span', 'cx-seg-head');
      const place = (el, from, to) => {
        el.style.left = (from / (last + 1) * 100) + '%';
        el.style.width = ((to - from + 1) / (last + 1) * 100) + '%';
      };
      state.segments.forEach((segment, n) => {
        const band = button('', () => edit(segment), 'Edit ' + segmentName(segment, n));
        band.className = 'cx-seg-band' + (segment.id === take.segmentId ? ' is-current' : '') + (segment.id === state.editing ? ' is-editing' : '');
        band.title = segmentName(segment, n) + ' · ' + at(segment.inFrame) + '–' + at(segment.outFrame + 1);
        place(band, segment.inFrame, Math.min(segment.outFrame, last));
        strip.appendChild(band);
      });
      strip.append(draft, head_);
      const coarse = node('input', 'cx-seg-coarse'); coarse.type = 'range'; coarse.min = '0'; coarse.max = String(last); coarse.step = '1';
      coarse.setAttribute('aria-label', 'Position in the clip');
      const fine = node('input', 'cx-seg-fine'); fine.type = 'range'; fine.min = String(-FINE_SPAN); fine.max = String(FINE_SPAN); fine.step = '1';
      fine.setAttribute('aria-label', 'Fine adjust, up to ' + FINE_SPAN + ' frames either way');
      const prev = button('◀', () => step(-1), 'One frame back');
      const next = button('▶', () => step(1), 'One frame forward');

      const marks = node('span', 'cx-trim-marks');
      const setIn = button('Set In here', () => markIn(current()), 'Set In at this frame (I)');
      const setOut = button('Set Out here', () => markOut(current()), 'Set Out at this frame (O)');
      const playDraft = button('▶ Play In–Out', () => playSpan(state.in, state.out, playDraft));
      const nudge = (which, delta) => {
        if (which === 'in') markIn(state.in + delta); else markOut(state.out + delta);
        state.base = which === 'in' ? state.in : state.out; state.fine = 0; update(); seek();
      };
      const inBack = button('−1', () => nudge('in', -1), 'Move In one frame back');
      const inOn = button('+1', () => nudge('in', 1), 'Move In one frame forward');
      const outBack = button('−1', () => nudge('out', -1), 'Move Out one frame back');
      const outOn = button('+1', () => nudge('out', 1), 'Move Out one frame forward');
      function markIn(frame) { state.in = Math.max(0, Math.min(last - 1, frame)); if (state.out <= state.in) state.out = state.in + 1; update(); }
      function markOut(frame) { state.out = Math.max(1, Math.min(last, frame)); if (state.in >= state.out) state.in = state.out - 1; update(); }

      function update() {
        const frame = current();
        coarse.value = String(state.base); fine.value = String(state.fine);
        const parts = ['Frame ' + frame + ' / ' + last, at(frame), Math.round(frame / last * 100) + '%'];
        if (frame === last) parts.push('last'); else if (frame === 0) parts.push('first');
        readout.textContent = parts.join(' · ');
        marks.textContent = 'In ' + at(state.in) + ' (frame ' + state.in + ') · Out ' + at(state.out + 1) + ' (frame ' + state.out + ') · plays ' + at(state.out + 1 - state.in);
        place(draft, state.in, state.out);
        head_.style.left = ((frame + 0.5) / (last + 1) * 100) + '%';
        prev.disabled = frame <= 0; next.disabled = frame >= last;
        setIn.disabled = frame >= last; setOut.disabled = frame <= 0;
        inBack.disabled = state.in <= 0; inOn.disabled = state.in >= last - 1;
        outBack.disabled = state.out <= 1; outOn.disabled = state.out >= last;
      }
      function select(base, offset) {
        state.base = clamp(base); state.fine = Math.max(-FINE_SPAN, Math.min(FINE_SPAN, offset));
        if (playing) video.pause();
        update(); seek();
      }
      function step(delta) {
        const target = current() + delta;
        if (target < 0 || target > last) return;
        // Past the fine slider's reach the coarse one moves instead, so stepping never stalls.
        if (Math.abs(state.fine + delta) > FINE_SPAN) select(target, 0); else select(state.base, state.fine + delta);
      }
      coarse.addEventListener('input', () => select(Number(coarse.value), 0));
      fine.addEventListener('input', () => select(state.base, Number(fine.value)));
      panel.addEventListener('keydown', event => {
        if (event.target.matches('input[type="text"], textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'i' && !setIn.disabled) { event.preventDefault(); markIn(current()); }
        else if (key === 'o' && !setOut.disabled) { event.preventDefault(); markOut(current()); }
      });

      const editing = state.editing && state.segments.find(g => g.id === state.editing);
      const label = node('input', 'cx-seg-label'); label.type = 'text'; label.maxLength = 80; label.value = state.label;
      label.placeholder = 'Name (optional)'; label.setAttribute('aria-label', 'Segment name');
      label.addEventListener('input', () => { state.label = label.value; });
      const status = node('p', 'cx-shot-status'); status.setAttribute('role', 'status');
      const save = button(editing ? 'Save segment' : 'Add segment', () => saveSegment(shot, take, status));
      save.className = 'btn-primary';
      label.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
      const editRow = node('div', 'cx-row cx-seg-edit');
      editRow.append(label, save);
      if (editing) {
        const cancel = button('Cancel edit', () => { state.editing = null; state.label = ''; renderTakes(shot); });
        cancel.className = 'btn-ghost';
        editRow.appendChild(cancel);
      }

      const scrub = node('div', 'cx-trim-scrub'); scrub.append(prev, fine, next);
      const markRow = node('div', 'cx-card-actions cx-trim-actions'); markRow.append(setIn, setOut, playDraft);
      const nudgeRow = node('div', 'cx-seg-nudge');
      nudgeRow.append(node('span', null, 'In'), inBack, inOn, node('span', null, 'Out'), outBack, outOn);
      panel.append(video, readout, strip, coarse, scrub, markRow, marks, nudgeRow);
      if (editing) {
        panel.appendChild(node('p', 'cx-board-note', 'Editing ' + segmentName(editing, state.segments.indexOf(editing))
          + (editing.usedBy ? '. Saving changes it for the ' + shotsWord(editing.usedBy) + ' that play it.' : '.')));
      }
      panel.append(editRow, status, segmentList(shot, take, playSpan), closeRow(take.segmentId
        ? Object.assign(button('Play the whole video in this shot', () => playIn(shot, take, null)), { className: 'btn-ghost' }) : null));
      update();
      return panel;

      function edit(segment) {
        state.editing = segment.id; state.label = segment.label;
        state.in = segment.inFrame; state.out = Math.min(segment.outFrame, last); state.base = state.in; state.fine = 0;
        renderTakes(shot);
      }
    }
    function segmentList(shot, take, playSpan) {
      const state = segmenting, list = node('ul', 'cx-seg-list');
      if (!state.segments.length) {
        const empty = node('li', 'cx-panel-empty', 'No segments yet. Set In and Out, then add one.');
        list.appendChild(empty);
        return list;
      }
      const at = frame => (frame / state.info.fps).toFixed(2) + ' s';
      const others = take.mine ? shots.filter(s => s.id !== shot.id) : [];
      state.segments.forEach((segment, n) => {
        const item = node('li', 'cx-seg-item' + (segment.id === take.segmentId ? ' is-current' : '') + (segment.id === state.editing ? ' is-editing' : ''));
        const text = node('div', 'cx-seg-text');
        text.append(node('span', 'cx-seg-name', segmentName(segment, n)),
          node('span', 'cx-seg-range', at(segment.inFrame) + '–' + at(segment.outFrame + 1) + ' · ' + at(segment.outFrame + 1 - segment.inFrame)));
        if (segment.usedBy) text.appendChild(node('span', 'cx-seg-used', 'in ' + shotsWord(segment.usedBy)));
        const actions = node('div', 'cx-card-actions');
        const play = button('▶ Play', () => playSpan(segment.inFrame, Math.min(segment.outFrame, state.info.lastFrame), play), 'Play ' + segmentName(segment, n));
        const edit = button('Edit', () => {
          state.editing = segment.id; state.label = segment.label;
          state.in = segment.inFrame; state.out = Math.min(segment.outFrame, state.info.lastFrame); state.base = state.in; state.fine = 0;
          renderTakes(shot);
        }, 'Edit ' + segmentName(segment, n));
        const here = segment.id === take.segmentId;
        const use = button(here ? 'Plays in this shot' : 'Play in this shot', () => { if (!here) playIn(shot, take, segment); },
          here ? segmentName(segment, n) + ' plays in this shot' : 'Play ' + segmentName(segment, n) + ' in this shot');
        use.setAttribute('aria-pressed', String(here));
        actions.append(play, edit, use);
        if (others.length) {
          const pick = node('select', 'cx-seg-use');
          pick.setAttribute('aria-label', 'Use ' + segmentName(segment, n) + ' in another shot');
          pick.appendChild(new Option('Use in shot…', ''));
          others.forEach(target => {
            const quote = target.quote || '', words = quote.length > 40 ? quote.slice(0, 39) + '…' : quote;
            pick.appendChild(new Option('Shot ' + (shots.indexOf(target) + 1) + ' · ' + words, target.id));
          });
          pick.addEventListener('change', () => {
            const target = shots.find(s => s.id === pick.value);
            if (target) useIn(target, take, segment, n);
          });
          actions.appendChild(pick);
        }
        const remove = button('Delete', () => deleteSegment(shot, take, segment, n), 'Delete ' + segmentName(segment, n));
        remove.classList.add('is-danger');
        actions.appendChild(remove);
        item.append(text, actions);
        list.appendChild(item);
      });
      return list;
    }
    function closeRow(extra) {
      const row = node('div', 'cx-row');
      if (extra) row.appendChild(extra);
      const close = button('Close', () => {
        const shot = segmenting && shots.find(s => s.id === segmenting.shotId);
        segmenting = null;
        if (shot) renderTakes(shot);
      });
      close.className = 'btn-ghost';
      row.appendChild(close);
      return row;
    }
    // A segment's frames show in the takes of every shot that plays it, so after a change every shot's takes are read again.
    async function refreshTakes() {
      const id = pageId;
      const fresh = await ctx.api('/pages/' + id + '/shots');
      if (id !== pageId) return;
      fresh.forEach(f => { const shot = shots.find(s => s.id === f.id); if (shot) { shot.takes = f.takes; renderTakes(shot); } });
    }
    async function reloadSegments(shot, take) {
      const state = segmenting;
      const segments = await ctx.api(takePath(shot, take) + '/segments');
      if (segmenting === state) state.segments = segments;
    }
    async function saveSegment(shot, take, status) {
      const state = segmenting;
      status.textContent = 'Saving…'; status.classList.remove('is-error');
      const body = { inFrame: state.in, outFrame: state.out, label: state.label };
      try {
        const path = takePath(shot, take) + '/segments' + (state.editing ? '/' + state.editing : '');
        const segments = await ctx.api(path, { method: state.editing ? 'PUT' : 'POST', body });
        const edited = Boolean(state.editing);
        if (segmenting === state) { state.segments = segments; state.editing = null; state.label = ''; }
        await refreshTakes();
        announce(edited ? 'Segment saved.' : 'Segment added.');
      } catch (error) { status.textContent = error.message; status.classList.add('is-error'); }
    }
    async function deleteSegment(shot, take, segment, n) {
      const used = segment.usedBy ? ' ' + (segment.usedBy === 1 ? 'One shot plays it; it' : shotsWord(segment.usedBy) + ' play it; they') + ' will play the whole video instead.' : '';
      const ok = await window.MobvisionConfirm.ask({ kicker: 'Storyboard', title: 'Delete ' + segmentName(segment, n) + '?',
        body: 'The segment is removed from this video.' + used + ' The file is not changed.', confirmLabel: 'Delete' });
      if (!ok) return;
      const state = segmenting;
      try {
        const segments = await ctx.api(takePath(shot, take) + '/segments/' + segment.id, { method: 'DELETE' });
        if (segmenting === state) { state.segments = segments; if (state.editing === segment.id) { state.editing = null; state.label = ''; } }
        await refreshTakes();
        announce('Segment deleted.');
      } catch (error) { announce(error.message); }
    }
    async function playIn(shot, take, segment) {
      try {
        const saved = await ctx.api(takePath(shot, take) + '/segment', { method: 'PUT', body: { segmentId: segment ? segment.id : null } });
        shot.takes = saved.takes;
        await reloadSegments(shot, take);
        renderTakes(shot);
        announce(segment ? 'This shot plays the segment.' : 'This shot plays the whole video again.');
      } catch (error) { announce(error.message); }
    }
    async function useIn(target, take, segment, n) {
      try {
        const saved = await ctx.api(shotPath(target) + '/takes', { method: 'POST', body: { jobId: take.jobId, segmentId: segment.id } });
        target.takes = saved.takes;
        renderTakes(target);
        const shot = shots.find(s => s.id === segmenting.shotId);
        if (shot) { await reloadSegments(shot, take); renderTakes(shot); }
        announce('Shot ' + (shots.indexOf(target) + 1) + ' has ' + segmentName(segment, n) + ' as a take. Keep it there to put it in the cut.');
      } catch (error) { announce(error.message); }
    }
    async function verdict(shot, take, value) {
      try {
        const saved = await ctx.api(shotPath(shot) + '/takes/' + take.id, { method: 'PUT', body: { verdict: value } });
        shot.takes = saved.takes; renderTakes(shot);
        if (value === 'keep') announce('Kept. Any earlier keep on this shot was cleared.');
      } catch (error) { announce(error.message); }
    }
    async function unlinkTake(shot, take) {
      const ok = await window.MobvisionConfirm.ask({ kicker: 'Storyboard', title: 'Unlink this take?',
        body: 'It leaves the storyboard. The render stays in ' + take.createdByName + '’s gallery.', confirmLabel: 'Unlink' });
      if (!ok) return;
      try { await ctx.api(shotPath(shot) + '/takes/' + take.id, { method: 'DELETE' }); }
      catch (error) { if (error.status !== 404) { announce(error.message); return; } }
      shot.takes = shot.takes.filter(t => t.id !== take.id); renderTakes(shot);
    }

    // ---------- coverage ----------
    // How much of the story has video: the words under a shot with a kept video take, of all the words. Mirrors
    // CodexRules.CountCoverage on the server (a word is a run of non-space characters with a letter or digit in it,
    // in a paragraph or heading, at the highest level of any character in it); keep the two in step.
    const wordChar = /[\p{L}\p{N}]/u, spaceChar = /\s/;
    function keptVideo(shot) { return shot.takes.find(t => t.verdict === 'keep' && t.kind === 'video' && t.status === 'completed' && t.hasResult); }
    function shotLevel(id) { const shot = shots.find(s => s.id === id); return !shot ? 0 : keptVideo(shot) ? 2 : 1; }
    function measureCoverage(doc) {
      const out = { words: 0, covered: 0, pending: 0, runs: [], gaps: [] };
      const word = (level, blockId) => {
        out.words++;
        if (level === 2) out.covered++; else if (level === 1) out.pending++;
        const last = out.runs[out.runs.length - 1];
        if (last && last.level === level) last.words++; else out.runs.push({ level, words: 1 });
        if (level < 2 && blockId && out.gaps[out.gaps.length - 1] !== blockId) out.gaps.push(blockId);
      };
      const markLevel = marks => (marks || []).reduce((best, m) => m.type === 'shot' && m.attrs ? Math.max(best, shotLevel(m.attrs.shotId)) : best, 0);
      function block(node) {
        const blockId = node.attrs && node.attrs.blockId;
        let any = false, inWord = false, best = 0;
        const chars = (text, level) => {
          for (const c of text) {
            if (spaceChar.test(c)) { if (inWord && any) word(best, blockId); inWord = any = false; best = 0; continue; }
            inWord = true; any = any || wordChar.test(c); best = Math.max(best, level);
          }
        };
        (node.content || []).forEach(child => {
          const level = markLevel(child.marks);
          if (child.type === 'text') chars(child.text || '', level);
          else if (child.type === 'mention') chars('@' + (child.attrs && child.attrs.label || ''), level);
          else if (child.type === 'hardBreak') chars(' ', 0);
        });
        if (inWord && any) word(best, blockId);
      }
      (function walk(node) {
        if (!node || node.type === 'codeBlock') return;
        if (node.type === 'paragraph' || node.type === 'heading') { block(node); return; }
        (node.content || []).forEach(walk);
      })(doc);
      return out;
    }
    function pageCoverage() {
      const editor = ctx.editor(), out = measureCoverage(editor ? editor.getJSON() : null);
      out.keptVideos = 0; out.runtime = 0;
      shots.forEach(s => { const take = keptVideo(s); if (take) { out.keptVideos++; out.runtime += take.playSeconds || 0; } });
      return out;
    }
    // The tree total comes from the server, which only has the saved page, so this page's part is swapped for the live one.
    function treeCoverage(page) {
      const report = tree && tree.pageId === pageId && tree.report;
      if (!report || report.pages < 2) return null;
      const t = report.tree, p = report.page;
      return { title: report.rootTitle, pages: report.pages, words: t.words - p.words + page.words,
        covered: t.coveredWords - p.coveredWords + page.covered, keptVideos: t.keptVideos - p.keptVideos + page.keptVideos,
        runtime: t.runtimeSeconds - p.runtimeSeconds + page.runtime };
    }
    let tree = null, treeLoading = null, coverageFrame = 0, textTimer = 0, gapAt = -1, coverageOn = false;
    try { coverageOn = localStorage.getItem('codex.coverage') === '1'; } catch (_) { /* storage blocked; starts off */ }
    function loadTree() {
      if (!pageId) return;
      const id = pageId;
      treeLoading = ctx.api('/pages/' + id + '/coverage')
        .then(report => { if (id === pageId) { tree = { pageId: id, report }; scheduleCoverage(); } }, () => { /* the page line still shows */ })
        .finally(() => { treeLoading = null; });
    }
    const percent = (part, whole) => whole ? Math.round(part / whole * 100) + '%' : '—';
    const clock = s => { const whole = Math.round(s); return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0'); };
    const count = n => n.toLocaleString('en-US');
    function scheduleCoverage() {
      if (coverageFrame) return;
      coverageFrame = requestAnimationFrame(() => { coverageFrame = 0; updateCoverage(); });
    }
    let last = null;
    function updateCoverage() {
      const page = pageId ? pageCoverage() : null;
      last = page;
      const toggle = $('cxCoverage'), next = $('cxNextGap');
      if (toggle) {
        toggle.textContent = 'Coverage ' + (page ? percent(page.covered, page.words) : '');
        toggle.setAttribute('aria-pressed', String(coverageOn));
        toggle.title = coverageOn ? 'Hide which passages have video' : 'Show which passages have video';
      }
      if (next) next.hidden = !(coverageOn && page && page.gaps.length);
      const editorEl = $('cxEditor');
      if (editorEl) editorEl.classList.toggle('is-coverage', coverageOn);
      paintCoverage();
      const box = $('cxCoverageSummary');
      if (box && page) fillSummary(box, page);
    }
    // Covered passages are marked by shot id; marks carry nothing else, and ids are checked before they reach the selector.
    function paintCoverage() {
      let style = document.getElementById('cxCoverageStyle');
      if (!style) { style = document.createElement('style'); style.id = 'cxCoverageStyle'; document.head.appendChild(style); }
      const ids = shots.filter(s => keptVideo(s) && /^[0-9a-f-]{36}$/i.test(s.id)).map(s => s.id);
      const css = ids.length ? ids.map(id => '.cx-editor.is-coverage mark.cx-shot[data-shot="' + id + '"]').join(',\n') + ' { background:var(--cx-covered-bg); border-bottom:2px solid var(--success); }' : '';
      if (style.textContent !== css) style.textContent = css;
    }
    function nextGap() {
      const page = last || pageCoverage();
      if (!page.gaps.length) { announce('Every passage has video.'); return; }
      gapAt = (gapAt + 1) % page.gaps.length;
      ctx.showWrite(); ctx.flash({ blockId: page.gaps[gapAt] });
      announce('Gap ' + (gapAt + 1) + ' of ' + page.gaps.length + '.');
    }
    function summaryBox() {
      const box = node('section', 'cx-coverage'); box.id = 'cxCoverageSummary';
      box.setAttribute('aria-label', 'Video coverage');
      return box;
    }
    function fillSummary(box, page) {
      box.textContent = '';
      const bar = node('div', 'cx-coverage-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', percent(page.covered, page.words) + ' of the page has video');
      page.runs.forEach(run => {
        const seg = node('span', 'cx-coverage-seg is-' + ['none', 'pending', 'covered'][run.level]);
        seg.style.flexGrow = String(run.words);
        bar.appendChild(seg);
      });
      const line = node('p', 'cx-coverage-line');
      line.append(node('strong', null, 'Coverage ' + percent(page.covered, page.words)),
        node('span', null, count(page.covered) + ' / ' + count(page.words) + ' words with video'
          + (page.pending ? ' · ' + count(page.pending) + ' waiting for a kept video' : '')
          + ' · ' + page.keptVideos + (page.keptVideos === 1 ? ' video kept' : ' videos kept')
          + (page.keptVideos ? ' · runtime ' + clock(page.runtime) : '')));
      if (page.gaps.length) {
        const gap = button('Next gap →', nextGap, 'Go to the next passage without video');
        gap.className = 'btn-ghost cx-coverage-gap';
        line.appendChild(gap);
      }
      box.append(bar, line);
      const whole = treeCoverage(page);
      if (whole) box.appendChild(node('p', 'cx-coverage-tree', 'Whole story, ' + whole.title + ' (' + whole.pages + ' pages): '
        + percent(whole.covered, whole.words) + ' · ' + count(whole.covered) + ' / ' + count(whole.words) + ' words · '
        + whole.keptVideos + (whole.keptVideos === 1 ? ' video' : ' videos') + (whole.keptVideos ? ' · runtime ' + clock(whole.runtime) : '')));
      else if (treeLoading) box.appendChild(node('p', 'cx-coverage-tree', 'Adding up the whole story…'));
    }
    const coverageButton = $('cxCoverage');
    if (coverageButton) coverageButton.addEventListener('click', () => {
      coverageOn = !coverageOn;
      try { localStorage.setItem('codex.coverage', coverageOn ? '1' : '0'); } catch (_) { /* per-browser convenience only */ }
      updateCoverage();
      announce(coverageOn ? 'Passages with video are highlighted; passages still waiting are underlined with dots.' : 'Coverage hidden.');
    });
    const gapButton = $('cxNextGap');
    if (gapButton) gapButton.addEventListener('click', nextGap);

    // ---------- order and deletion ----------
    async function saveOrder() {
      render(); ctx.refreshBadges();
      try { await ctx.api('/pages/' + pageId + '/shots/order', { method: 'POST', body: { ids: shots.map(s => s.id) } }); }
      catch (error) { announce(error.message); await reload(); }
    }
    function move(shot, delta) {
      const at = shots.indexOf(shot), to = at + delta;
      if (at < 0 || to < 0 || to >= shots.length) return;
      shots.splice(at, 1); shots.splice(to, 0, shot);
      saveOrder().then(() => { const card = document.querySelector('[data-shot-card="' + shot.id + '"] [aria-label^="Move shot"]:not(:disabled)'); if (card) card.focus(); });
      announce('Shot moved to position ' + (to + 1) + '.');
    }
    let dragging = null;
    function wireDrag(card, shot) {
      card.draggable = true;
      card.addEventListener('dragstart', event => {
        if (event.target.closest('textarea, select, input, video')) { event.preventDefault(); return; }
        dragging = shot; card.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', shot.id);
      });
      card.addEventListener('dragend', () => { dragging = null; card.classList.remove('is-dragging'); });
      card.addEventListener('dragover', event => { if (dragging && dragging !== shot) { event.preventDefault(); card.classList.add('is-drop'); } });
      card.addEventListener('dragleave', () => card.classList.remove('is-drop'));
      card.addEventListener('drop', event => {
        event.preventDefault(); card.classList.remove('is-drop');
        if (!dragging || dragging === shot) return;
        const from = shots.indexOf(dragging);
        shots.splice(from, 1);
        shots.splice(shots.indexOf(shot) + (from <= shots.indexOf(shot) ? 1 : 0), 0, dragging);
        dragging = null;
        saveOrder();
      });
    }
    async function deleteShot(shot) {
      const at = shots.indexOf(shot) + 1;
      const ok = await window.MobvisionConfirm.ask({ kicker: 'Storyboard', title: 'Delete shot ' + at + '?',
        body: shot.takes.length ? 'Its ' + shot.takes.length + ' take(s) leave the storyboard but stay in their makers’ galleries. The passage loses its shot marker.' : 'The passage loses its shot marker.',
        confirmLabel: 'Delete shot' });
      if (!ok) return;
      try { await ctx.api(shotPath(shot), { method: 'DELETE' }); }
      catch (error) { if (error.status !== 404) { announce(error.message); return; } }
      shots = shots.filter(s => s !== shot);
      if (ctx.editor().commands.removeShot(shot.id)) ctx.markDirty();
      ctx.refreshBadges();
      render();
    }

    return {
      setPage(id, list) {
        pageId = id; shots = list || []; clearTimeout(pollTimer);
        promptTimers.forEach(clearTimeout); promptTimers.clear(); queues.clear(); notes.clear(); busy.clear();
        tagFilter = null; segmenting = null; tree = null; gapAt = -1;
        if (cut) cut.reset();
        render(); schedulePoll(); loadTree();
      },
      clear() { pageId = null; shots = []; tagFilter = null; segmenting = null; tree = null; clearTimeout(pollTimer); if (cut) cut.reset(); render(); },
      show() { visible = true; if (canEdit()) loadLimits(); render(); loadTree(); },
      // The page's own coverage follows the text as it is typed; the rest of the tree is read when the page opens.
      textChanged() { clearTimeout(textTimer); textTimer = setTimeout(scheduleCoverage, 400); },
      hide() { visible = false; if (cut) cut.stop(); },
      badge,
      createFromSelection,
      focusCard,
      count: () => shots.length,
    };
  };
})();
