/* The cut: a page's shots and those of every page inside it, played back to back.
   A kept video plays its trim (or whole), a kept image holds as a still, and a shot without either shows its
   passage on a title card, so the gaps stay visible while watching. Used by codex-storyboard.js. */
(function () {
  'use strict';

  const STILL_SECONDS = 3, CARD_SECONDS = 2, GUESS_SECONDS = 5;

  window.CodexCut = function (ctx) {
    const { node, announce } = ctx;
    let cut = null, cutFor = null, loading = null, error = null, root = null;
    let segments = [], index = 0, playing = false, ended = false, elapsed = 0, frame = 0, lastTick = 0;
    let stage = null, videos = [], still = null, card = null, caption = null, playBtn = null, time = null, timeline = null, active = null;

    const clock = s => { const whole = Math.max(0, Math.round(s)); return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0'); };
    const media = take => '/api/codex/takes/' + take.id + '/media';
    const total = () => segments.reduce((sum, s) => sum + s.duration, 0);
    const before = i => segments.slice(0, i).reduce((sum, s) => sum + s.duration, 0);

    function segmentsOf(data) {
      const out = [];
      data.pages.forEach(page => page.shots.forEach((shot, n) => {
        const seg = { page, shot, number: n + 1, kind: 'card', duration: CARD_SECONDS };
        const take = shot.take;
        if (take && take.kind === 'video') {
          const trimmed = take.trimFps > 0 && take.trimIn !== null && take.trimOut !== null;
          Object.assign(seg, { kind: 'video', src: media(take), start: trimmed ? take.trimIn / take.trimFps : 0,
            end: trimmed ? (take.trimOut + 1) / take.trimFps : null, duration: take.playSeconds || GUESS_SECONDS });
        } else if (take) Object.assign(seg, { kind: 'still', src: media(take), duration: STILL_SECONDS });
        out.push(seg);
      }));
      return out;
    }

    // ---------- loading ----------
    function load(pageId) {
      cutFor = pageId; cut = null; error = null; root = null;
      const id = pageId;
      loading = ctx.api('/pages/' + id + '/cut')
        .then(data => { if (cutFor === id) { cut = data; segments = segmentsOf(data); index = 0; elapsed = 0; ended = false; } },
          e => { if (cutFor === id) error = e.message; })
        .finally(() => { if (cutFor === id) { loading = null; ctx.changed(); } });
    }

    /** The cut's view for a page, built once per load so re-rendering the board does not stop playback. */
    function view(pageId) {
      if (cutFor !== pageId) load(pageId);
      if (loading) return node('p', 'cx-panel-empty', 'Putting the cut together…');
      if (error) return node('p', 'cx-board-note is-warn', 'The cut did not load: ' + error);
      if (!root) root = build();
      return root;
    }

    // ---------- building ----------
    function build() {
      const box = node('div', 'cx-cut');
      if (!segments.length) {
        box.appendChild(node('p', 'cx-panel-empty', 'No shots on this page or the pages inside it yet. In Write, select text inside a paragraph and choose 🎬 Shot.'));
        return box;
      }
      const videoCount = segments.filter(s => s.kind === 'video').length, stills = segments.filter(s => s.kind === 'still').length;
      box.appendChild(node('p', 'cx-help', segments.length + (segments.length === 1 ? ' shot' : ' shots') + ' across '
        + cut.pages.filter(p => p.shots.length).length + ' of ' + cut.pages.length + ' pages: ' + videoCount + ' with video, '
        + stills + (stills === 1 ? ' still' : ' stills') + ', ' + (segments.length - videoCount - stills) + ' still to make. Runs ' + clock(total()) + '.'));
      box.appendChild(player());
      box.appendChild(list());
      show(0, false);
      return box;
    }

    function player() {
      const wrap = node('section', 'cx-cut-player');
      wrap.setAttribute('aria-label', 'The cut');
      stage = node('div', 'cx-cut-stage');
      videos = [0, 1].map(() => {
        const v = node('video', 'cx-cut-media');
        v.playsInline = true; v.preload = 'auto'; v.hidden = true;
        v.addEventListener('ended', () => { if (v === active && playing) advance(); });
        v.addEventListener('error', () => { if (v === active && v.dataset.src) failed(); });
        v.addEventListener('loadedmetadata', () => {
          const seg = segments.find(s => s.src === v.dataset.src);
          if (!seg) return;
          if (seg.end === null && isFinite(v.duration)) { seg.duration = Math.max(0.1, v.duration - seg.start); paintTimeline(); }
          if (v !== active || v.currentTime < seg.start) v.currentTime = seg.start;
        });
        stage.appendChild(v);
        return v;
      });
      still = node('img', 'cx-cut-media'); still.alt = ''; still.hidden = true;
      card = node('div', 'cx-cut-card'); card.hidden = true;
      stage.append(still, card);
      caption = node('p', 'cx-cut-caption');
      caption.setAttribute('aria-live', 'polite');

      const controls = node('div', 'cx-cut-controls');
      const prev = button('⏮', () => jump(index - 1), 'Previous shot');
      playBtn = button('▶ Play', toggle, 'Play the cut');
      playBtn.classList.add('cx-cut-play');
      const next = button('⏭', () => jump(index + 1), 'Next shot');
      time = node('span', 'cx-cut-time');
      controls.append(prev, playBtn, next, time);

      timeline = node('div', 'cx-cut-timeline');
      segments.forEach((seg, i) => {
        const b = node('button', 'cx-cut-seg is-' + seg.kind);
        b.type = 'button';
        b.setAttribute('aria-label', 'Shot ' + seg.number + ' of ' + seg.page.title + ': ' + seg.shot.quote);
        b.title = seg.page.title + ' · Shot ' + seg.number;
        b.appendChild(node('span', 'cx-cut-fill'));
        b.addEventListener('click', () => jump(i));
        timeline.appendChild(b);
      });
      paintTimeline();
      wrap.append(stage, caption, controls, timeline);
      return wrap;
    }

    function list() {
      const box = node('div', 'cx-cut-list');
      let at = 0;
      const empty = cut.pages.filter(p => !p.shots.length).length;
      cut.pages.forEach(page => {
        if (!page.shots.length) return;
        const section = node('section', 'cx-cut-page');
        section.style.setProperty('--depth', String(Math.min(page.depth, 4)));
        const head = node('h3', 'cx-cut-page-title');
        head.append(ctx.kindChip(page.pageType), document.createTextNode(' ' + page.title));
        const items = node('ol', 'cx-cut-shots');
        page.shots.forEach(() => {
          const seg = segments[at], i = at++;
          const li = node('li', 'cx-cut-shot is-' + seg.kind);
          const thumb = node('span', 'cx-cut-thumb');
          if (seg.kind === 'still') { const img = node('img'); img.src = seg.src; img.alt = ''; img.loading = 'lazy'; thumb.appendChild(img); }
          else if (seg.kind === 'video') { const v = node('video'); v.muted = true; v.preload = 'none'; v.dataset.lazy = seg.src + '#t=' + seg.start.toFixed(3); thumb.appendChild(v); lazyThumb(v); }
          const text = node('span', 'cx-cut-shot-text');
          text.append(node('span', 'cx-cut-shot-num', 'Shot ' + seg.number),
            node('span', 'cx-cut-shot-quote', seg.shot.quote),
            node('span', 'cx-cut-shot-state', seg.kind === 'video' ? 'Video · ' + clock(seg.duration) : seg.kind === 'still' ? 'Still image' : 'No video yet'));
          const open = node('button', 'cx-cut-open');
          open.type = 'button';
          open.setAttribute('aria-label', 'Open shot ' + seg.number + ' of ' + page.title);
          open.append(thumb, text);
          open.addEventListener('click', () => { stop(); ctx.openShot(page.id, seg.shot.id); });
          const from = button('▶', () => { jump(i); if (!playing) toggle(); }, 'Play the cut from shot ' + seg.number + ' of ' + page.title);
          from.classList.add('cx-cut-from');
          li.append(open, from);
          items.appendChild(li);
        });
        section.append(head, items);
        box.appendChild(section);
      });
      if (empty) box.appendChild(node('p', 'cx-panel-empty', empty + (empty === 1 ? ' page inside has' : ' pages inside have') + ' no shots.'));
      return box;
    }

    let observer = null;
    function lazyThumb(v) {
      if (!('IntersectionObserver' in window)) { v.src = v.dataset.lazy; v.preload = 'metadata'; return; }
      observer = observer || new IntersectionObserver(entries => entries.forEach(e => {
        if (!e.isIntersecting) return;
        observer.unobserve(e.target); e.target.preload = 'metadata'; e.target.src = e.target.dataset.lazy;
      }), { rootMargin: '200px' });
      observer.observe(v);
    }

    function button(label, onClick, aria) {
      const b = node('button', 'btn-ghost', label);
      b.type = 'button';
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', onClick);
      return b;
    }

    // ---------- playing ----------
    function show(i, autoplay) {
      const seg = segments[i];
      if (!seg) return;
      index = i; elapsed = 0; ended = false;
      // A take that failed while it waited in the other player becomes a card before it is shown.
      if (seg.kind === 'video' && videos.some(v => v.dataset.src === seg.src && v.error)) { broken(seg); paintTimeline(); }
      videos.forEach(v => v.pause());
      still.hidden = card.hidden = true;
      if (seg.kind === 'video') {
        const ready = videos.find(v => v.dataset.src === seg.src);
        active = ready || videos.find(v => v !== active) || videos[0];
        if (active.dataset.src !== seg.src) { active.dataset.src = seg.src; active.src = seg.src; }
        else if (active.readyState >= 1) active.currentTime = seg.start;
        videos.forEach(v => { v.hidden = v !== active; });
        if (autoplay) active.play().catch(() => pause());
      } else {
        videos.forEach(v => { v.hidden = true; });
        active = null;
        if (seg.kind === 'still') { still.src = seg.src; still.hidden = false; }
        else showCard(seg.shot.quote, seg.failed ? 'This take could not be played.' : seg.page.title + ' · Shot ' + seg.number + ' · no video yet');
      }
      caption.textContent = seg.page.title + ' · Shot ' + seg.number + ': ' + seg.shot.quote;
      preloadAfter(i);
      paint();
    }
    function showCard(text, sub) {
      card.textContent = '';
      card.append(node('p', 'cx-cut-card-quote', text), node('p', 'cx-cut-card-sub', sub));
      card.hidden = false;
    }
    // The next video waits in the other player, so the cut does not stop to load it.
    function preloadAfter(i) {
      const next = segments.slice(i + 1).find(s => s.kind === 'video');
      if (!next || videos.some(v => v.dataset.src === next.src)) return;
      const idle = videos.find(v => v !== active);
      if (idle) { idle.dataset.src = next.src; idle.src = next.src; }
    }
    function broken(seg) { seg.kind = 'card'; seg.duration = CARD_SECONDS; seg.failed = true; }
    function failed() {
      const seg = segments[index];
      if (seg.kind !== 'video') return;
      broken(seg);
      if (active) { active.hidden = true; active.pause(); }
      active = null;
      showCard(seg.shot.quote, 'This take could not be played.');
      paintTimeline();
      elapsed = 0;
    }
    function toggle() { if (playing) pause(); else play(); }
    function play() {
      if (!segments.length) return;
      if (ended) show(0, false);
      playing = true;
      playBtn.textContent = '⏸ Pause'; playBtn.setAttribute('aria-label', 'Pause the cut');
      if (active) active.play().catch(() => pause());
      lastTick = performance.now();
      cancelAnimationFrame(frame); frame = requestAnimationFrame(tick);
    }
    function pause() {
      playing = false;
      if (playBtn) { playBtn.textContent = '▶ Play'; playBtn.setAttribute('aria-label', 'Play the cut'); }
      videos.forEach(v => v.pause());
      cancelAnimationFrame(frame);
    }
    function tick(now) {
      if (!playing) return;
      const seg = segments[index], dt = (now - lastTick) / 1000;
      lastTick = now;
      if (seg.kind === 'video' && active) {
        elapsed = Math.max(0, active.currentTime - seg.start);
        if (seg.end !== null && active.currentTime >= seg.end - 0.02) { advance(); return; }
      } else {
        elapsed += dt;
        if (elapsed >= seg.duration) { advance(); return; }
      }
      paint();
      frame = requestAnimationFrame(tick);
    }
    function advance() {
      if (index + 1 < segments.length) { show(index + 1, true); if (playing) { lastTick = performance.now(); frame = requestAnimationFrame(tick); } return; }
      pause();
      elapsed = segments[index].duration; ended = true;
      paint();
      announce('The cut has ended.');
    }
    function jump(i) {
      if (i < 0 || i >= segments.length) return;
      show(i, playing);
      if (playing) { lastTick = performance.now(); cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }
    }
    function paint() {
      if (!time) return;
      time.textContent = clock(before(index) + Math.min(elapsed, segments[index].duration)) + ' / ' + clock(total());
      Array.from(timeline.children).forEach((b, i) => {
        b.classList.toggle('is-current', i === index);
        b.firstChild.style.width = (i < index ? 100 : i > index ? 0 : Math.min(100, elapsed / segments[i].duration * 100)) + '%';
        if (i === index) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
    }
    function paintTimeline() {
      if (!timeline) return;
      Array.from(timeline.children).forEach((b, i) => { b.style.flexGrow = String(segments[i].duration); b.className = 'cx-cut-seg is-' + segments[i].kind + (i === index ? ' is-current' : ''); });
      paint();
    }

    function stop() { if (playing) pause(); }
    function reset() {
      stop();
      if (observer) { observer.disconnect(); observer = null; }
      cut = null; cutFor = null; loading = null; error = null; root = null; segments = []; active = null;
      stage = caption = playBtn = time = timeline = still = card = null; videos = [];
    }

    // ---------- exporting ----------
    // The server renders the same sequence into one MP4 in the caller's gallery. The control is kept per page and scope, so
    // re-rendering the board does not restart its polling, and it picks up an export still running after a reload.
    let exp = null;
    const EXPORT_POLL_MS = 3000;
    function exporter(pageId, withChildren) {
      const key = pageId + (withChildren ? ':tree' : ':page');
      if (exp && exp.key === key) return exp.box;
      if (exp) clearTimeout(exp.timer);
      const box = node('div', 'cx-cut-export');
      const btn = button('⬇ Export MP4', () => startExport(), withChildren
        ? 'Export this page and the pages inside it as one MP4' : 'Export this page’s shots as one MP4');
      const line = node('span', 'cx-cut-export-status');
      line.setAttribute('aria-live', 'polite');
      box.append(btn, line);
      exp = { key, pageId, withChildren, box, btn, line, timer: null, state: null };
      pollExport(exp);
      return box;
    }
    function startExport() {
      const e = exp;
      e.btn.disabled = true;
      paintExport(e, { state: 'queued', done: 0, total: 0 });
      ctx.api('/pages/' + e.pageId + '/cut/export?withChildren=' + e.withChildren, { method: 'POST' })
        .then(status => { if (exp === e) { paintExport(e, status); scheduleExport(e); } },
          error => { if (exp === e) paintExport(e, { state: 'failed', error: error.message }); });
    }
    function pollExport(e) {
      ctx.api('/pages/' + e.pageId + '/cut/export')
        .then(status => { if (exp === e) { paintExport(e, status); scheduleExport(e); } },
          () => { if (exp === e) scheduleExport(e); });
    }
    function scheduleExport(e) {
      clearTimeout(e.timer);
      if (e.state === 'queued' || e.state === 'rendering') e.timer = setTimeout(() => { if (exp === e) pollExport(e); }, EXPORT_POLL_MS);
    }
    function paintExport(e, status) {
      const was = e.state, state = status && status.state || 'none';
      e.state = state;
      const busy = state === 'queued' || state === 'rendering';
      e.btn.disabled = busy;
      e.line.textContent = '';
      e.line.classList.toggle('is-warn', state === 'failed');
      if (state === 'queued') e.line.textContent = 'Waiting its turn to render…';
      else if (state === 'rendering') e.line.textContent = 'Rendering shot ' + Math.min(status.total, status.done + 1) + ' of ' + status.total + '…';
      else if (state === 'failed') e.line.textContent = status.error || 'The export failed.';
      else if (state === 'done' && status.assetId) {
        const link = node('a', null, status.filename || 'the MP4');
        link.href = '/media/' + status.assetId;
        link.download = status.filename || '';
        e.line.append('Saved to your gallery: ', link);
      }
      if (was && was !== state && state === 'done') announce('The export is ready in your gallery.');
      if (was && was !== state && state === 'failed') announce('The export failed.');
    }

    return { view, stop, reset, exporter };
  };
})();
