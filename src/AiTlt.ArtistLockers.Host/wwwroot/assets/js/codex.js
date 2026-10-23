(function () {
  'use strict';
  // The Codex: a page tree, a TipTap editor (assets/vendor/codex-editor.min.js, built by tools/codex-editor)
  // and the board tasks made from highlighted passages. Tasks live on the board; the page holds only anchor marks.
  const $ = id => document.getElementById(id);
  const kit = window.CodexEditorKit;
  const apiRoot = '/api/codex';
  const statusLabels = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
  const typeLabels = { page: 'Page', world: 'World', story: 'Story', chapter: 'Chapter', character: 'Character', place: 'Place', item: 'Item', faction: 'Faction', event: 'Event' };
  const shortType = { page: 'Page', world: 'World', story: 'Story', chapter: 'Ch', character: 'Char', place: 'Place', item: 'Item', faction: 'Fact', event: 'Event' };
  const SAVE_DELAY = 1500;

  let pages = [], pageTypes = Object.keys(typeLabels), current = null, anchors = [], backlinks = [], team = null;
  let editor = null, dirty = false, saving = null, saveTimer = 0, conflict = false, loadingPage = false;
  let pendingSelection = null, pendingPageSelection = null, searchTimer = 0, searchVersion = 0, lastFocus = null;
  let board = null, genImage = null, view = 'write';
  const viewScroll = { write: null, board: null };
  let treePreferenceKey = null, browserCollapsed = false;
  let expandedPages = new Set();
  let panelWidth = null, panelWidthKey = null;
  // Every member has the Codex; staff (the Lore and Production teams and the admins) also get the storyboard and generation.
  let staff = false;
  // Every page tree belongs to the owner of its top-level page, who may share it to read or to edit.
  let access = 'none', rootId = null, shares = [], people = null;

  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const announce = text => { $('cxLive').textContent = ''; setTimeout(() => { $('cxLive').textContent = text; }, 30); };
  const pageById = id => pages.find(p => p.id === id);
  const childrenOf = parentId => pages.filter(p => (p.parentId || null) === (parentId || null)).sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const uuid = () => crypto.randomUUID();
  const writable = level => level === 'owner' || level === 'edit';
  const canEdit = () => !!current && writable(access);

  async function api(path, options) {
    options = options || {};
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(apiRoot + path, { method: options.method || 'GET', credentials: 'include', headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const error = new Error(data && (data.error || data.message) || (res.status === 403 ? 'You do not have access to this.' : 'The Codex did not answer (' + res.status + ').'));
      error.status = res.status; error.data = data; throw error;
    }
    return data;
  }

  // ---------- save state ----------
  function setSave(text, isError) { const el = $('cxSave'); el.textContent = text; el.classList.toggle('is-error', !!isError); }
  function markDirty() {
    if (!current || loadingPage || !canEdit()) return;
    dirty = true;
    if (conflict) return;
    setSave('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }
  function bodyFor(version) {
    return { parentId: current.parentId || null, pageType: current.pageType, title: $('cxTitle').value.trim(), doc: editor.getJSON(), version };
  }
  // Saves now; resolves true when the page on the server matches the editor.
  async function save() {
    clearTimeout(saveTimer);
    if (saving) { await saving; return dirty ? save() : true; }
    if (!current || !dirty) return true;
    if (conflict) return false;
    const body = bodyFor(current.version);
    if (!body.title) { setSave('A title is needed to save', true); return false; }
    const page = current;
    dirty = false;
    setSave('Saving…');
    saving = (async () => {
      try {
        const saved = await api('/pages/' + page.id, { method: 'PUT', body });
        page.version = saved.version;
        page.updatedAt = saved.updatedAt;
        const summary = pageById(page.id);
        if (summary) { summary.title = body.title; summary.pageType = body.pageType; summary.version = saved.version; }
        if (page === current) { renderTree(); renderCrumb(); $('cxEdited').textContent = 'Saved ' + timeLabel(saved.updatedAt); }
        setSave(dirty ? 'Unsaved changes' : 'Saved');
        return true;
      } catch (error) {
        dirty = true;
        if (error.status === 409 && error.data && error.data.conflict) { conflict = true; $('cxConflict').hidden = false; setSave('Not saved: conflict', true); }
        else if (error.status === 403 || error.status === 404) setSave('Not saved: ' + (error.status === 404 ? 'this page is no longer shared with you.' : error.message), true);
        else { setSave('Not saved: ' + error.message, true); saveTimer = setTimeout(save, 10000); }
        return false;
      } finally { saving = null; }
    })();
    const ok = await saving;
    if (ok && dirty && !conflict) { clearTimeout(saveTimer); saveTimer = setTimeout(save, SAVE_DELAY); }
    return ok;
  }
  function timeLabel(value) {
    const date = new Date(value), seconds = (Date.now() - date.getTime()) / 1000;
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---------- tree ----------
  function kindChip(type) { const chip = node('span', 'cx-kind', shortType[type] || type); chip.dataset.kind = type; return chip; }
  function storeTreePreferences() {
    if (!treePreferenceKey) return;
    try { localStorage.setItem(treePreferenceKey, JSON.stringify({ expanded: [...expandedPages], collapsed: browserCollapsed })); }
    catch (_) { /* Browsing remains usable when storage is blocked or full. */ }
  }
  function loadTreePreferences(userId) {
    const key = userId ? 'mobvision.codex.pages.v1.' + userId : null;
    if (key === treePreferenceKey) return;
    treePreferenceKey = key; expandedPages = new Set(); browserCollapsed = false;
    panelWidthKey = userId ? 'mobvision.codex.panel-width.v1.' + userId : null;
    panelWidth = null;
    try {
      const savedWidth = panelWidthKey && Number(localStorage.getItem(panelWidthKey));
      if (Number.isFinite(savedWidth) && savedWidth >= 220 && savedWidth <= 480) panelWidth = savedWidth;
    } catch (_) { /* Use the responsive default when storage is unavailable. */ }
    updatePanelWidth();
    try {
      const saved = key && JSON.parse(localStorage.getItem(key));
      if (saved && Array.isArray(saved.expanded)) expandedPages = new Set(saved.expanded.filter(id => typeof id === 'string'));
      browserCollapsed = !!(saved && saved.collapsed === true);
    } catch (_) { /* A fresh compact tree is the fallback. */ }
    updatePageBrowser();
  }
  function updatePageBrowser() {
    $('cxPageBrowser').hidden = browserCollapsed;
    $('cxPagesToggle').setAttribute('aria-expanded', String(!browserCollapsed));
    $('cxPagesToggle').title = browserCollapsed ? 'Show page browser' : 'Hide page browser';
    $('cxPageBrowser').closest('.cx-left').classList.toggle('is-collapsed', browserCollapsed);
  }
  function revealPageBranch(id) {
    const seen = new Set();
    for (let page = pageById(id); page && page.parentId && !seen.has(page.id); page = pageById(page.parentId)) {
      seen.add(page.id); expandedPages.add(page.parentId);
    }
    storeTreePreferences();
  }
  function setAllBranches(open) {
    expandedPages = open ? new Set(pages.filter(p => childrenOf(p.id).length).map(p => p.id)) : new Set();
    storeTreePreferences(); renderTree();
    announce(open ? 'All page branches expanded.' : 'All page branches collapsed.');
  }
  function renderTree(revealCurrent = false) {
    if ($('cxSearch').value.trim()) return;
    const list = $('cxTree');
    const scrollTop = list.scrollTop;
    const focusId = list.contains(document.activeElement) ? document.activeElement.id : null;
    list.textContent = '';
    const parentsOfCurrent = new Set();
    for (let page = current && pageById(current.id); page && page.parentId && !parentsOfCurrent.has(page.parentId); page = pageById(page.parentId)) parentsOfCurrent.add(page.parentId);
    const visited = new Set();
    const item = (page, depth, parent) => {
      if (visited.has(page.id)) return;
      visited.add(page.id);
      const children = childrenOf(page.id), open = expandedPages.has(page.id);
      const li = node('li'), row = node('div', 'cx-tree-row'), btn = node('button', 'cx-tree-page');
      row.style.setProperty('--depth', Math.min(depth, 5));
      row.classList.toggle('contains-current', !open && parentsOfCurrent.has(page.id));
      if (children.length) {
        const toggle = node('button', 'cx-tree-toggle'), chevron = node('span', 'cx-chevron', '›');
        const childrenId = 'cx-children-' + page.id;
        toggle.type = 'button'; toggle.id = 'cx-toggle-' + page.id;
        toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-controls', childrenId);
        toggle.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + page.title + ' (' + children.length + ' sub-pages)');
        chevron.setAttribute('aria-hidden', 'true'); toggle.append(chevron);
        const changeBranch = expanded => {
          if (expanded) expandedPages.add(page.id); else expandedPages.delete(page.id);
          storeTreePreferences(); renderTree();
        };
        toggle.addEventListener('click', () => changeBranch(!expandedPages.has(page.id)));
        toggle.addEventListener('keydown', event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault(); changeBranch(event.key === 'ArrowRight');
        });
        row.append(toggle);
      } else row.append(node('span', 'cx-tree-spacer'));
      btn.type = 'button';
      btn.id = 'cx-page-' + page.id; btn.title = page.title;
      btn.append(kindChip(page.pageType), node('span', 'cx-name', page.title));
      if (children.length) {
        const count = node('span', 'cx-child-count', children.length);
        count.setAttribute('aria-label', children.length + ' sub-pages'); btn.append(count);
      }
      if (page.tasks) btn.append(node('span', 'cx-count', page.tasks + (page.tasks === 1 ? ' task' : ' tasks')));
      if (current && current.id === page.id) btn.setAttribute('aria-current', 'page');
      btn.addEventListener('click', () => openPage(page.id));
      row.append(btn); li.append(row); parent.append(li);
      if (children.length) {
        const group = node('ul', 'cx-tree-children'); group.id = 'cx-children-' + page.id; group.hidden = !open;
        li.append(group); children.forEach(child => item(child, depth + 1, group));
      }
    };
    const roots = childrenOf(null), own = roots.filter(p => p.access === 'owner'), shared = roots.filter(p => p.access !== 'owner');
    own.forEach(page => item(page, 0, list));
    if (!own.length) list.appendChild(node('li', 'cx-tree-empty', shared.length ? 'No pages of your own yet.' : 'No pages yet.'));
    // Pages shared with the viewer, grouped under the person who owns them.
    const owners = [...new Set(shared.map(p => p.ownerName))].sort((a, b) => a.localeCompare(b));
    owners.forEach(name => {
      list.appendChild(node('li', 'cx-tree-head', 'Shared by ' + name));
      shared.filter(p => p.ownerName === name).forEach(page => item(page, 0, list));
    });
    list.scrollTop = scrollTop;
    if (focusId) $(focusId)?.focus({ preventScroll: true });
    // Keep the selected page in the tree's viewport without moving the document.
    const selected = list.querySelector('[aria-current="page"]');
    if (revealCurrent && selected && selected.getClientRects().length) {
      const treeBounds = list.getBoundingClientRect(), bounds = selected.getBoundingClientRect();
      if (bounds.top < treeBounds.top) list.scrollTop += bounds.top - treeBounds.top;
      else if (bounds.bottom > treeBounds.bottom) list.scrollTop += bounds.bottom - treeBounds.bottom;
    }
  }
  function rootsInOrder() {
    const roots = childrenOf(null);
    return roots.filter(p => p.access === 'owner').concat(roots.filter(p => p.access !== 'owner'));
  }
  async function runSearch() {
    const q = $('cxSearch').value.trim(), version = ++searchVersion;
    if (!q) { renderTree(); return; }
    let hits = [];
    try { hits = await api('/search?q=' + encodeURIComponent(q)); } catch (error) { hits = null; }
    if (version !== searchVersion) return;
    const list = $('cxTree');
    list.textContent = '';
    if (!hits) { list.appendChild(node('li', 'cx-tree-empty', 'Search is unavailable.')); return; }
    if (!hits.length) { list.appendChild(node('li', 'cx-tree-empty', 'Nothing matches “' + q + '”.')); return; }
    hits.forEach(hit => {
      const li = node('li'), btn = node('button'), text = node('span', 'cx-hit');
      btn.type = 'button';
      text.append(node('span', 'cx-name', hit.title), node('small', null, hit.snippet));
      btn.append(kindChip(hit.pageType), text);
      btn.addEventListener('click', () => openPage(hit.pageId));
      li.appendChild(btn); list.appendChild(li);
    });
  }
  function renderCrumb() {
    const crumb = $('cxCrumb');
    crumb.textContent = '';
    if (!current) return;
    const chain = [];
    for (let p = pageById(current.parentId); p && chain.length < 12; p = pageById(p.parentId)) chain.unshift(p);
    chain.forEach(p => {
      const btn = node('button', null, p.title); btn.type = 'button';
      btn.addEventListener('click', () => openPage(p.id));
      crumb.append(btn, node('span', null, '›'));
    });
    crumb.appendChild(node('b', null, $('cxTitle').value.trim() || 'Untitled'));
  }
  function descendantsOf(id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) { grew = false; pages.forEach(p => { if (p.parentId && out.has(p.parentId) && !out.has(p.id)) { out.add(p.id); grew = true; } }); }
    return out;
  }
  // Offers the pages the viewer may write in. Moving keeps a page inside its owner's pages; only the owner may make it top-level.
  function fillParentSelect(select, selected, excludeId, ownerId) {
    select.textContent = '';
    if (!excludeId || access === 'owner') select.appendChild(new Option('Top level', ''));
    const blocked = excludeId ? descendantsOf(excludeId) : new Set();
    const walk = (parentId, depth) => childrenOf(parentId).forEach(p => {
      if (blocked.has(p.id)) return;
      if (!parentId && (!writable(p.access) || ownerId && p.ownerId !== ownerId)) return;
      select.appendChild(new Option('  '.repeat(depth) + p.title + ' · ' + (typeLabels[p.pageType] || p.pageType), p.id));
      walk(p.id, depth + 1);
    });
    walk(null, 0);
    select.value = selected || '';
    if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
  }
  function fillTypeSelect(select, selected) {
    select.textContent = '';
    pageTypes.forEach(t => select.appendChild(new Option(typeLabels[t] || t, t)));
    select.value = selected || 'page';
  }
  async function reloadTree() {
    const data = await api('');
    pages = data.pages || [];
    loadTreePreferences(data.userId);
    if (data.pageTypes && data.pageTypes.length) pageTypes = data.pageTypes;
    renderTree();
  }

  // ---------- page ----------
  async function openPage(id, blockId, options) {
    options = options || {};
    const previousPageId = current && current.id;
    if (blockId) showView('write');
    if (current && current.id === id && !options.reload) {
      revealPageBranch(id); renderTree(true);
      if (blockId) revealBlock(blockId); return;
    }
    if (current && dirty && !options.discard) {
      const ok = await save();
      if (!ok) { announce('This page is not saved yet. Resolve that before leaving it.'); setSave($('cxSave').textContent, true); return; }
    }
    let data;
    try { data = await api('/pages/' + id); }
    catch (error) {
      if (error.status === 404) { announce('That page is not available: it was deleted or is no longer shared with you.'); await reloadTree(); if (!current || !pageById(current.id)) showFirstPage(); return; }
      setSave(error.message, true); return;
    }
    current = data.page; anchors = data.anchors || []; backlinks = data.backlinks || [];
    if (current.id !== previousPageId) { viewScroll.write = null; viewScroll.board = null; }
    access = data.access || 'read'; rootId = data.rootId || current.id; shares = data.shares || [];
    dirty = false; conflict = false; clearTimeout(saveTimer);
    $('cxConflict').hidden = true;
    $('cxEmpty').hidden = true; $('cxDoc').hidden = false;
    $('cxTitle').value = current.title;
    fillTypeSelect($('cxType'), current.pageType);
    $('cxEdited').textContent = 'Edited ' + timeLabel(current.updatedAt) + (current.updatedByName ? ' by ' + current.updatedByName : '');
    $('cxPageMenu').open = false;
    loadingPage = true;
    clearTimeout(flashTimer);
    editor.commands.flash(null);
    const assignedBefore = editor.storage.blockId.assigned;
    editor.commands.setContent(current.doc, { emitUpdate: false });
    if (staff) board.setPage(current.id, data.shots || []); else board.clear();
    genImage.setPage(current.id);
    editor.commands.refreshBadges();
    loadingPage = false;
    // Paragraphs saved before they had ids get them on load; save them so tasks and links can point there.
    if (editor.storage.blockId.assigned !== assignedBefore) markDirty(); else setSave('');
    const summary = pageById(current.id);
    if (summary) { current.parentId = summary.parentId; }
    applyAccess();
    revealPageBranch(current.id);
    renderTree(true); renderCrumb(); renderPanels();
    const url = new URL(location.href);
    url.searchParams.set('page', current.id);
    if (blockId) url.searchParams.set('block', blockId); else url.searchParams.delete('block');
    history.replaceState(null, '', url);
    document.title = current.title + ' · Codex · Mobvision';
    if (blockId) requestAnimationFrame(() => revealBlock(blockId));
    else if (current.id !== previousPageId) window.scrollTo({
      top: previousPageId && matchMedia('(max-width:720px)').matches ? viewStart() : 0, behavior: 'instant'
    });
  }
  // Read-only pages keep reading, mentions and Show passage, and lose everything that changes them.
  function applyAccess() {
    if (!current) return;
    const editable = canEdit(), owner = access === 'owner';
    editor.setEditable(editable, false);
    $('cxTitle').readOnly = !editable;
    $('cxType').disabled = !editable;
    $('cxToolbar').hidden = view === 'board' || !editable;
    $('cxGenImageBtn').hidden = !(staff && editable && genImage && genImage.allowed());
    if (!editable) hideBubble();
    $('cxPageMenu').hidden = !(owner || editable && current.parentId);
    $('cxDelete').hidden = !owner;
    $('cxShare').hidden = !owner;
    const summary = pageById(rootId) || pageById(current.id), chip = $('cxOwner');
    if (!owner) chip.textContent = 'Shared by ' + (summary ? summary.ownerName : 'another editor') + (editable ? ' · Can edit' : ' · Read only');
    else chip.textContent = shares.length ? 'Shared with ' + shares.map(s => s.name).join(', ') : '';
    chip.hidden = !chip.textContent;
  }
  let flashTimer = 0;
  function flash(target) {
    if (!editor.commands.flash(target)) return false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => editor.commands.flash(null), 2400);
    const el = $('cxEditor').querySelector('.cx-flash');
    if (el) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return true;
  }
  function revealBlock(blockId) {
    if (!/^b[a-z0-9]{6,16}$/.test(blockId || '')) return;
    if (!flash({ blockId })) announce('That passage is no longer on this page.');
  }
  function revealAnchor(anchor) {
    showView('write');
    if (!flash({ anchorId: anchor.id })) revealBlock(anchor.blockId);
  }
  function showFirstPage() {
    const first = rootsInOrder()[0];
    if (first) { openPage(first.id); return; }
    current = null;
    board.clear();
    $('cxDoc').hidden = true; $('cxEmpty').hidden = false;
    renderCrumb(); renderPanels();
  }

  // ---------- badges and panels ----------
  function renderBadge(anchorId) {
    const anchor = anchors.find(a => a.id === anchorId);
    if (!anchor) return null;
    const badge = node('span', 'cx-badge'), dot = node('span', 'cx-dot');
    dot.dataset.status = anchor.status;
    badge.append(dot, document.createTextNode(anchor.taskSlug));
    badge.contentEditable = 'false';
    badge.title = anchor.taskTitle + ' · ' + (statusLabels[anchor.status] || anchor.status);
    badge.setAttribute('role', 'button');
    badge.addEventListener('mousedown', event => event.preventDefault());
    badge.addEventListener('click', () => { selectTab('tasks'); const card = document.querySelector('[data-anchor-card="' + anchorId + '"]'); if (card) { card.scrollIntoView({ block: 'nearest' }); card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash'); } });
    return badge;
  }
  function roleName(key) { return (team && team.roles.find(r => r.key === key) || {}).displayName || key; }
  function renderPanels() {
    const tasks = $('cxPanelTasks'), links = $('cxPanelLinks');
    tasks.textContent = ''; links.textContent = '';
    $('cxTaskCount').textContent = current ? String(anchors.length) : '';
    $('cxLinkCount').textContent = current ? String(backlinks.length) : '';
    if (!current) return;
    if (!anchors.length) tasks.appendChild(node('p', 'cx-panel-empty', canEdit() ? 'Select a passage and choose Task to put it on the team board.' : 'No tasks on this page.'));
    const marked = current ? new Set(kit.anchorRanges(editor.state.doc).keys()) : new Set();
    anchors.forEach(anchor => {
      const card = node('div', 'cx-card');
      card.dataset.anchorCard = anchor.id;
      const chips = node('div', 'cx-chips'), status = node('span', 'cx-chip'), dot = node('span', 'cx-dot');
      dot.dataset.status = anchor.status;
      status.append(dot, document.createTextNode(statusLabels[anchor.status] || anchor.status));
      chips.append(node('span', 'cx-chip', anchor.taskSlug), node('span', 'cx-chip is-team', roleName(anchor.kind)), status);
      if (anchor.assigneeName) chips.appendChild(node('span', 'cx-chip', anchor.assigneeName));
      const actions = node('div', 'cx-card-actions');
      const jump = node('button', null, 'Show passage'); jump.type = 'button';
      jump.addEventListener('click', () => revealAnchor(anchor));
      const open = node('a', null, 'Open on board'); open.href = '/tasks.html?item=' + encodeURIComponent(anchor.taskSlug);
      const unlink = node('button', 'is-danger', 'Unlink'); unlink.type = 'button';
      unlink.addEventListener('click', () => unlinkAnchor(anchor));
      actions.append(jump, open);
      if (canEdit()) actions.appendChild(unlink);
      card.append(node('div', 'cx-card-title', anchor.taskTitle), chips, node('div', 'cx-card-quote', '“' + anchor.quote + '”'));
      if (!marked.has(anchor.id)) card.appendChild(node('div', 'cx-card-missing', 'The highlighted text was edited away; the task still points at its paragraph.'));
      card.appendChild(actions);
      tasks.appendChild(card);
    });
    if (!backlinks.length) links.appendChild(node('p', 'cx-panel-empty', 'No other page mentions this one yet.'));
    backlinks.forEach(link => {
      const card = node('button', 'cx-card cx-link-card'); card.type = 'button';
      const head = node('div', 'cx-chips');
      head.append(kindChip(link.pageType), node('span', 'cx-card-title', link.title));
      card.append(head, node('div', 'cx-card-quote', link.snippet));
      card.addEventListener('click', () => openPage(link.pageId, link.blockId));
      links.appendChild(card);
    });
  }
  function selectTab(which) {
    const tasks = which === 'tasks';
    $('cxTabTasks').setAttribute('aria-selected', String(tasks)); $('cxTabTasks').tabIndex = tasks ? 0 : -1;
    $('cxTabLinks').setAttribute('aria-selected', String(!tasks)); $('cxTabLinks').tabIndex = tasks ? -1 : 0;
    $('cxPanelTasks').hidden = !tasks; $('cxPanelLinks').hidden = tasks;
  }
  // Write and Storyboard share the centre pane; the storyboard reads the passages from the editor.
  function viewStart() {
    const navHeight = parseFloat(getComputedStyle($('codexMain')).getPropertyValue('--cx-nav-height')) || 64;
    return Math.max(0, document.querySelector('.cx-center').getBoundingClientRect().top + window.scrollY - navHeight);
  }
  function showView(which) {
    if (!staff) which = 'write';
    const changed = which !== view;
    if (changed) viewScroll[view] = window.scrollY;
    view = which;
    const isBoard = which === 'board';
    $('cxViewWrite').setAttribute('aria-selected', String(!isBoard)); $('cxViewWrite').tabIndex = isBoard ? -1 : 0;
    $('cxViewBoard').setAttribute('aria-selected', String(isBoard)); $('cxViewBoard').tabIndex = isBoard ? 0 : -1;
    $('cxToolbar').hidden = isBoard || !canEdit(); $('cxDocWrap').hidden = isBoard; $('cxBoard').hidden = !isBoard;
    hideBubble();
    if (isBoard) board.show(); else board.hide();
    if (changed) window.scrollTo({ top: viewScroll[which] ?? viewStart(), behavior: 'instant' });
  }
  async function refreshAnchors() {
    if (!current) return;
    const id = current.id;
    try {
      const fresh = await api('/pages/' + id + '/anchors');
      if (!current || current.id !== id) return;
      anchors = fresh; editor.commands.refreshBadges(); renderPanels();
    } catch (_) { /* status refresh is best effort */ }
  }
  async function unlinkAnchor(anchor) {
    const ok = await window.MobvisionConfirm.ask({ kicker: 'Codex', title: 'Unlink ' + anchor.taskSlug + '?',
      body: 'The task stays on the board. The passage loses its highlight and the task leaves this page.', confirmLabel: 'Unlink' });
    if (!ok) return;
    try { await api('/pages/' + current.id + '/anchors/' + anchor.id, { method: 'DELETE' }); }
    catch (error) { if (error.status !== 404) { announce(error.message); return; } }
    anchors = anchors.filter(a => a.id !== anchor.id);
    editor.commands.removeAnchor(anchor.id);
    editor.commands.refreshBadges();
    renderPanels();
    const summary = pageById(current.id); if (summary) { summary.tasks = anchors.length; renderTree(); }
  }

  // ---------- selection: bubble, tasks, pages from selection ----------
  function selectionInfo() {
    const { state } = editor, sel = state.selection;
    if (sel.empty || !sel.$from) return null;
    const text = state.doc.textBetween(sel.from, sel.to, ' ').trim();
    if (!text) return null;
    const sameBlock = sel.$from.sameParent(sel.$to) && sel.$from.parent.isTextblock;
    return { from: sel.from, to: sel.to, text, blockId: sameBlock ? sel.$from.parent.attrs.blockId : null, blockType: sameBlock ? sel.$from.parent.type.name : null };
  }
  function showBubble(at) {
    const info = selectionInfo(), bubble = $('cxBubble');
    if (!info || !canEdit() || !editor.isFocused && !at) { bubble.hidden = true; return; }
    const task = bubble.querySelector('[data-bubble="task"]');
    task.disabled = !info.blockId || !team || !team.canCreateTasks;
    task.title = !team || !team.canCreateTasks ? 'Creating board tasks needs a team role.' : !info.blockId ? 'Select text inside one paragraph.' : 'Put this passage on the team board';
    const shot = bubble.querySelector('[data-bubble="shot"]');
    shot.hidden = !staff;
    shot.disabled = !info.blockId || info.blockType !== 'paragraph';
    shot.title = shot.disabled ? 'A shot is made from text inside one paragraph.' : 'Put this passage on the storyboard';
    bubble.hidden = false;
    let x, y;
    if (at) { x = at.x; y = at.y + 8; }
    else {
      const start = editor.view.coordsAtPos(info.from), end = editor.view.coordsAtPos(info.to);
      x = (start.left + end.left) / 2 - bubble.offsetWidth / 2; y = start.top - bubble.offsetHeight - 8;
      if (y < 72) y = end.bottom + 8;
    }
    bubble.style.left = Math.max(8, Math.min(x, innerWidth - bubble.offsetWidth - 8)) + 'px';
    bubble.style.top = Math.max(8, Math.min(y, innerHeight - bubble.offsetHeight - 8)) + 'px';
  }
  function hideBubble() { $('cxBubble').hidden = true; }

  function openBackdrop(id, focusId) {
    lastFocus = document.activeElement;
    hideBubble();
    $(id).hidden = false;
    document.body.classList.add('cx-modal-open');
    $(focusId).focus();
  }
  function closeBackdrop(id) {
    $(id).hidden = true;
    document.body.classList.toggle('cx-modal-open', !!document.querySelector('.cx-backdrop:not([hidden])'));
    if (lastFocus && lastFocus.isConnected) lastFocus.focus(); else editor.commands.focus();
  }

  async function ensureTeam() {
    if (team) return team;
    try { team = await api('/team'); } catch (_) { team = { canCreateTasks: false, roles: [], team: [] }; }
    return team;
  }
  function openTaskDialog() {
    const info = selectionInfo();
    if (!info || !info.blockId || !team || !team.canCreateTasks) return;
    pendingSelection = info;
    $('cxTaskQuote').textContent = info.text;
    $('cxTaskTitle').value = info.text.length > 90 ? info.text.slice(0, 89).trimEnd() + '…' : info.text;
    const kind = $('cxTaskKind');
    kind.textContent = '';
    team.roles.forEach(r => kind.appendChild(new Option(r.displayName, r.key)));
    const assignee = $('cxTaskAssignee');
    assignee.length = 1;
    team.team.forEach(u => assignee.appendChild(new Option(u.displayName, u.id)));
    $('cxTaskError').textContent = '';
    $('cxTaskSubmit').disabled = false;
    openBackdrop('cxTaskBackdrop', 'cxTaskTitle');
    $('cxTaskTitle').select();
  }
  async function submitTask(event) {
    event.preventDefault();
    const info = pendingSelection;
    if (!info || !current) return;
    $('cxTaskSubmit').disabled = true; $('cxTaskError').textContent = '';
    // The paragraph id must be saved before the board points at it.
    if (dirty && !(await save())) { $('cxTaskError').textContent = 'Save the page first (' + $('cxSave').textContent + ').'; $('cxTaskSubmit').disabled = false; return; }
    const request = { anchorId: uuid(), blockId: info.blockId, quote: info.text.slice(0, 4000), title: $('cxTaskTitle').value.trim(),
      kind: $('cxTaskKind').value, assigneeId: $('cxTaskAssignee').value || null };
    try {
      const anchor = await api('/pages/' + current.id + '/tasks', { method: 'POST', body: request });
      anchors.push(anchor);
      closeBackdrop('cxTaskBackdrop');
      editor.chain().setAnchor(anchor.id, info.from, info.to).setTextSelection(info.to).run();
      editor.commands.refreshBadges();
      renderPanels();
      const summary = pageById(current.id); if (summary) { summary.tasks = anchors.length; renderTree(); }
      announce(anchor.taskSlug + ' is on the team board.');
    } catch (error) { $('cxTaskError').textContent = error.message; $('cxTaskSubmit').disabled = false; }
  }

  function openPageDialog(fromSelection) {
    const info = fromSelection ? selectionInfo() : null;
    pendingPageSelection = info;
    $('cxPageTitle').value = info ? info.text.slice(0, 180) : '';
    fillTypeSelect($('cxPageType'), info ? 'character' : 'page');
    fillParentSelect($('cxPageParent'), current && canEdit() ? (info ? current.parentId || '' : current.id) : '');
    $('cxPageHelp').hidden = !info;
    $('cxPageError').textContent = '';
    $('cxPageSubmit').disabled = false;
    openBackdrop('cxPageBackdrop', 'cxPageTitle');
    $('cxPageTitle').select();
  }
  async function submitPage(event) {
    event.preventDefault();
    const title = $('cxPageTitle').value.trim();
    if (!title) { $('cxPageError').textContent = 'A title is required.'; return; }
    $('cxPageSubmit').disabled = true;
    const id = uuid(), info = pendingPageSelection;
    const body = { parentId: $('cxPageParent').value || null, pageType: $('cxPageType').value, title,
      doc: { type: 'doc', content: [{ type: 'paragraph' }] }, version: 0 };
    try {
      await api('/pages/' + id, { method: 'PUT', body });
      closeBackdrop('cxPageBackdrop');
      if (info && current) {
        editor.chain().focus().insertContentAt({ from: info.from, to: info.to }, [{ type: 'mention', attrs: { id, label: title } }, { type: 'text', text: ' ' }]).run();
        await save();
      }
      await reloadTree();
      if (!info) await openPage(id); else announce('Created “' + title + '”.');
    } catch (error) { $('cxPageError').textContent = error.message; $('cxPageSubmit').disabled = false; }
  }

  // ---------- sharing ----------
  async function openShareDialog() {
    if (!current || access !== 'owner') return;
    const root = pageById(rootId), title = root ? root.title : current.title;
    $('cxShareHeading').textContent = 'Share “' + title + '”';
    $('cxShareHelp').textContent = rootId === current.id ? 'Everything inside this page is shared along with it.'
      : 'This page sits inside “' + title + '”, which is what gets shared, with everything inside it.';
    $('cxShareError').textContent = '';
    $('cxShareFind').value = '';
    if (!people) { try { people = await api('/people'); } catch (error) { $('cxShareError').textContent = error.message; } }
    renderShares();
    openBackdrop('cxShareBackdrop', $('cxShareFind').disabled ? 'cxShareClose' : 'cxShareFind');
  }
  function renderShares() {
    const list = $('cxShareList');
    list.textContent = '';
    if (!shares.length) list.appendChild(node('li', 'cx-panel-empty', 'Only you can see it.'));
    shares.forEach(share => {
      const li = node('li', 'cx-share-row'), level = node('select'), remove = node('button', 'btn-ghost is-danger', 'Remove');
      level.append(new Option('Can read', 'read'), new Option('Can edit', 'edit'));
      level.value = share.access;
      level.setAttribute('aria-label', 'What ' + share.name + ' can do');
      level.addEventListener('change', () => putShare(share.userId, level.value));
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Stop sharing with ' + share.name);
      remove.addEventListener('click', () => removeShare(share.userId));
      li.append(node('span', 'cx-name', share.name), level, remove);
      list.appendChild(li);
    });
    renderPeople();
  }
  // Staff get the other staff first (the server sends them marked and on top); everyone else gets one list by name.
  function renderPeople() {
    const taken = new Set(shares.map(s => s.userId)), query = $('cxShareFind').value.trim().toLowerCase();
    const free = (people || []).filter(p => !taken.has(p.id)), shown = free.filter(p => !query || p.name.toLowerCase().includes(query));
    const person = $('cxSharePerson');
    person.textContent = '';
    const team = shown.filter(p => p.staff), others = shown.filter(p => !p.staff);
    const fill = (parent, list) => list.forEach(p => parent.appendChild(new Option(p.name, p.id)));
    if (team.length) {
      const group = Object.assign(document.createElement('optgroup'), { label: 'Lore and Production' });
      fill(group, team); person.appendChild(group);
      if (others.length) { const rest = Object.assign(document.createElement('optgroup'), { label: 'Everyone else' }); fill(rest, others); person.appendChild(rest); }
    } else fill(person, others);
    if (!shown.length) person.appendChild(new Option(!free.length ? (people && people.length ? 'Everyone has it already' : 'There is nobody to share with')
      : 'Nobody matches “' + $('cxShareFind').value.trim() + '”', ''));
    person.disabled = $('cxShareAccess').disabled = $('cxShareSubmit').disabled = !shown.length;
    $('cxShareFind').disabled = !free.length;
    if (!$('cxShareBackdrop').hidden && !$('cxShareBackdrop').contains(document.activeElement)) (free.length ? $('cxShareFind') : $('cxShareClose')).focus();
  }
  async function changeShares(request) {
    $('cxShareError').textContent = '';
    try { shares = await request(); announce('Sharing updated.'); }
    catch (error) { $('cxShareError').textContent = error.message; }
    renderShares(); applyAccess();
  }
  const putShare = (userId, level) => changeShares(() => api('/pages/' + rootId + '/shares', { method: 'PUT', body: { userId, access: level } }));
  const removeShare = userId => changeShares(() => api('/pages/' + rootId + '/shares/' + userId, { method: 'DELETE' }));

  // ---------- links ----------
  function openLinkDialog() {
    $('cxLinkHref').value = editor.getAttributes('link').href || '';
    $('cxLinkRemove').hidden = !editor.isActive('link');
    $('cxLinkError').textContent = '';
    openBackdrop('cxLinkBackdrop', 'cxLinkHref');
  }
  function submitLink(event) {
    event.preventDefault();
    let href = $('cxLinkHref').value.trim();
    if (href && !/^[a-z][a-z0-9+.-]*:|^[/#.]/i.test(href) && /^[^\s/]+\.[a-z]{2,}([/?#]|$)/i.test(href)) href = 'https://' + href;
    if (!kit.isSafeHref(href)) { $('cxLinkError').textContent = 'Use a web or mail address, or a link inside the site.'; return; }
    closeBackdrop('cxLinkBackdrop');
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }

  // ---------- @mentions ----------
  const suggestion = {
    char: '@',
    items: ({ query }) => {
      const q = (query || '').toLowerCase();
      return pages.filter(p => (!current || p.id !== current.id) && p.title.toLowerCase().includes(q))
        .sort((a, b) => a.title.toLowerCase().indexOf(q) - b.title.toLowerCase().indexOf(q) || a.title.localeCompare(b.title)).slice(0, 8);
    },
    command: ({ editor: ed, range, props }) => {
      ed.chain().focus().insertContentAt(range, [{ type: 'mention', attrs: { id: props.id, label: props.label } }, { type: 'text', text: ' ' }]).run();
    },
    render: () => {
      let items = [], index = 0, command = null;
      const box = $('cxSuggest');
      const draw = () => {
        box.textContent = '';
        if (!items.length) { box.appendChild(node('p', null, 'No page by that name. Select text and choose + Page to create one.')); return; }
        items.forEach((p, i) => {
          const btn = node('button'); btn.type = 'button';
          btn.setAttribute('role', 'option'); btn.setAttribute('aria-selected', String(i === index));
          btn.append(kindChip(p.pageType), node('span', 'cx-name', p.title));
          btn.addEventListener('mousedown', event => { event.preventDefault(); command({ id: p.id, label: p.title }); });
          box.appendChild(btn);
        });
      };
      const place = rect => {
        if (!rect) return;
        const r = rect();
        if (!r) return;
        box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
        box.style.top = (r.bottom + box.offsetHeight + 12 > innerHeight ? r.top - box.offsetHeight - 6 : r.bottom + 6) + 'px';
      };
      return {
        onStart: props => { items = props.items; index = 0; command = props.command; box.hidden = false; draw(); place(props.clientRect); },
        onUpdate: props => { items = props.items; index = 0; command = props.command; draw(); place(props.clientRect); },
        onKeyDown: ({ event }) => {
          if (event.key === 'Escape') { box.hidden = true; return true; }
          if (!items.length) return false;
          if (event.key === 'ArrowDown') { index = (index + 1) % items.length; draw(); return true; }
          if (event.key === 'ArrowUp') { index = (index + items.length - 1) % items.length; draw(); return true; }
          if (event.key === 'Enter' || event.key === 'Tab') { const p = items[index]; command({ id: p.id, label: p.title }); return true; }
          return false;
        },
        onExit: () => { box.hidden = true; box.textContent = ''; },
      };
    },
  };

  // ---------- toolbar ----------
  const commands = {
    bold: () => editor.chain().focus().toggleBold().run(),
    italic: () => editor.chain().focus().toggleItalic().run(),
    strike: () => editor.chain().focus().toggleStrike().run(),
    h2: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    h3: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    quote: () => editor.chain().focus().toggleBlockquote().run(),
    bullets: () => editor.chain().focus().toggleBulletList().run(),
    numbers: () => editor.chain().focus().toggleOrderedList().run(),
    link: () => openLinkDialog(),
    image: () => window.MobvisionAssetPicker.open({ source: apiRoot + '/gallery', title: 'Insert an image', kind: 'image',
      onPick: (url, asset) => { if (asset && asset.id) insertImage(asset); }, onUploadRequest: uploadImage }),
    genimage: () => genImage.open(),
    mention: () => editor.chain().focus().insertContent((editor.state.selection.$from.nodeBefore?.text || '').match(/\S$/) ? ' @' : '@').run(),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
  };
  function insertImage(asset) {
    editor.chain().focus().setImage({ src: '/api/codex/assets/' + asset.id, alt: asset.description || asset.filename || '', assetId: asset.id }).run();
  }
  // Upload from the picker: the file goes to the caller's own gallery (tagged codex), then straight onto the page.
  const uploadTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxUploadBytes = 25 * 1024 * 1024;
  function uploadProblem(file) {
    if (!uploadTypes.includes(file.type)) return file.name + ' is not a PNG, JPEG, WebP or GIF image.';
    if (file.size > maxUploadBytes) return file.name + ' is over 25 MB.';
    return null;
  }
  async function uploadToGallery(file) {
    const form = new FormData();
    form.append('meta', JSON.stringify({ filename: file.name, description: '', tags: ['codex'] }));
    form.append('file', file);
    const res = await fetch('/api/v1/library/mine', { method: 'POST', credentials: 'include', body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.id) throw new Error(data && (data.error || data.message) || 'The upload of ' + file.name + ' did not go through (' + res.status + ').');
    return data;
  }
  function uploadImage() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: uploadTypes.join(',') });
    input.addEventListener('change', async () => {
      const file = input.files[0], picker = window.MobvisionAssetPicker;
      if (!file) return;
      const problem = uploadProblem(file);
      if (problem) { picker.status(problem, true); return; }
      picker.busy(true); picker.status('Uploading ' + file.name + '…');
      try {
        const data = await uploadToGallery(file);
        picker.close();
        insertImage(data);
        announce('Uploaded ' + file.name + ' and put it on the page.');
      } catch (error) { picker.busy(false); picker.status(error.message, true); }
    });
    input.click();
  }
  // Images dropped or pasted onto the page: each goes to the gallery, then onto the page where it landed, in order.
  // The spot is carried through every edit made while the uploads run; leaving the page keeps them in the gallery only.
  async function placeFiles(files, pos) {
    if (!current || !canEdit()) return;
    const pageId = current.id, spot = { pos };
    const follow = ({ transaction }) => { spot.pos = transaction.mapping.map(spot.pos, 1); };
    editor.on('transaction', follow);
    const skipped = [];
    let placed = 0, stranded = 0;
    try {
      for (const file of files) {
        const problem = uploadProblem(file);
        if (problem) { skipped.push(problem); continue; }
        setSave('Uploading ' + file.name + '…');
        try {
          const data = await uploadToGallery(file);
          if (!current || current.id !== pageId || !canEdit()) { stranded++; continue; }
          const at = Math.min(spot.pos, editor.state.doc.content.size);
          // The writer's cursor stays where it was; the next image goes below this one.
          editor.chain().insertContentAt(at, { type: 'image', attrs: { src: '/api/codex/assets/' + data.id, alt: data.description || data.filename || '', assetId: data.id } }, { updateSelection: false }).run();
          editor.state.doc.descendants((n, p) => { if (n.type.name === 'image' && n.attrs.assetId === data.id && p >= at - 2) { spot.pos = p + n.nodeSize; return false; } });
          placed++;
        } catch (error) { skipped.push(error.message); }
      }
    } finally { editor.off('transaction', follow); }
    const parts = [];
    if (placed) parts.push(placed === 1 ? 'Put 1 image on the page.' : 'Put ' + placed + ' images on the page.');
    if (stranded) parts.push(stranded + ' went to your gallery only, because you left the page.');
    parts.push(...skipped);
    const text = parts.join(' ');
    if (skipped.length) setSave(text, true); else if (!placed) setSave(text);
    announce(text);
  }
  const activeChecks = {
    bold: () => editor.isActive('bold'), italic: () => editor.isActive('italic'), strike: () => editor.isActive('strike'),
    h2: () => editor.isActive('heading', { level: 2 }), h3: () => editor.isActive('heading', { level: 3 }),
    quote: () => editor.isActive('blockquote'), bullets: () => editor.isActive('bulletList'), numbers: () => editor.isActive('orderedList'),
    link: () => editor.isActive('link'),
  };
  function updateToolbar() {
    document.querySelectorAll('#cxToolbar [data-cmd]').forEach(btn => {
      const check = activeChecks[btn.dataset.cmd];
      if (check) btn.setAttribute('aria-pressed', String(check()));
    });
    const undo = document.querySelector('[data-cmd="undo"]'), redo = document.querySelector('[data-cmd="redo"]');
    undo.disabled = !editor.can().undo(); redo.disabled = !editor.can().redo();
  }

  // Keep enough room for the editor when a saved wide panel meets a smaller window.
  function panelWidthBounds() {
    const wide = window.matchMedia('(min-width:1101px)').matches;
    const available = document.querySelector('.cx-shell').getBoundingClientRect().width;
    return { min: 220, max: Math.max(220, Math.min(480, Math.floor(available - (wide ? 704 : 372)))), defaultWidth: wide ? 240 : 220 };
  }
  function contentPanelWidth(defaultWidth) {
    const list = $('cxTree');
    if (browserCollapsed || !list.getClientRects().length || window.matchMedia('(max-width:720px)').matches) return defaultWidth;
    const horizontalSpace = element => {
      const style = getComputedStyle(element);
      return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, property) => sum + (parseFloat(style[property]) || 0), 0);
    };
    const range = document.createRange();
    const textWidth = element => { range.selectNodeContents(element); return range.getBoundingClientRect().width; };
    let widest = 0;
    list.querySelectorAll('button:not(.cx-tree-toggle)').forEach(button => {
      if (!button.getClientRects().length) return; // Collapsed descendants do not influence the width.
      const name = button.querySelector('.cx-name');
      if (!name) return;
      const text = button.querySelector('.cx-hit') || name;
      const siblings = [...button.children].filter(child => child !== text);
      const gap = parseFloat(getComputedStyle(button).columnGap) || 0;
      let width = textWidth(name) + horizontalSpace(button) + gap * siblings.length;
      siblings.forEach(child => { width += child.getBoundingClientRect().width; });
      const row = button.closest('.cx-tree-row');
      if (row) width += horizontalSpace(row) + row.firstElementChild.getBoundingClientRect().width;
      widest = Math.max(widest, width);
    });
    list.querySelectorAll('.cx-tree-head, .cx-tree-empty').forEach(label => {
      if (label.getClientRects().length) widest = Math.max(widest, textWidth(label) + horizontalSpace(label));
    });
    // Include indentation, badges, the drag handle and the scrollbar without measuring truncated boxes.
    return Math.max(defaultWidth, Math.ceil(widest + horizontalSpace(list) + horizontalSpace($('cxLeftPanel')) + (list.offsetWidth - list.clientWidth) + 4));
  }
  function updatePanelWidth() {
    const bounds = panelWidthBounds(), width = Math.max(bounds.min, Math.min(bounds.max, panelWidth ?? contentPanelWidth(bounds.defaultWidth)));
    document.querySelector('.cx-shell').style.setProperty('--cx-left-width', width + 'px');
    const handle = $('cxPanelResize');
    handle.setAttribute('aria-valuemin', bounds.min);
    handle.setAttribute('aria-valuemax', bounds.max);
    handle.setAttribute('aria-valuenow', width);
    handle.setAttribute('aria-valuetext', width + ' pixels' + (panelWidth == null ? ', automatic width' : ', fixed width'));
    $('cxAutoWidth').setAttribute('aria-pressed', String(panelWidth == null));
  }
  function storePanelWidth() {
    if (!panelWidthKey) return;
    try {
      if (panelWidth == null) localStorage.removeItem(panelWidthKey);
      else localStorage.setItem(panelWidthKey, String(panelWidth));
    } catch (_) { /* Resizing still works without storage. */ }
  }
  function wirePanelResize() {
    const handle = $('cxPanelResize');
    let drag = null;
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      handle.classList.remove('is-dragging'); document.body.classList.remove('cx-resizing');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      storePanelWidth();
    };
    handle.addEventListener('pointerdown', event => {
      if (drag || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); handle.focus();
      drag = { id: event.pointerId, x: event.clientX, width: $('cxLeftPanel').getBoundingClientRect().width };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging'); document.body.classList.add('cx-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const bounds = panelWidthBounds();
      panelWidth = Math.round(Math.max(bounds.min, Math.min(bounds.max, drag.width + event.clientX - drag.x)));
      updatePanelWidth();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => handle.addEventListener(type, finish));
    const reset = () => { panelWidth = null; updatePanelWidth(); storePanelWidth(); announce('Pages panel width fits visible titles automatically.'); };
    $('cxAutoWidth').addEventListener('click', () => {
      if (panelWidth != null) { reset(); return; }
      panelWidth = Number(handle.getAttribute('aria-valuenow'));
      updatePanelWidth(); storePanelWidth(); announce('Pages panel width fixed.');
    });
    handle.addEventListener('dblclick', reset);
    handle.addEventListener('keydown', event => {
      const bounds = panelWidthBounds();
      if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const width = Number(handle.getAttribute('aria-valuenow')), step = event.shiftKey ? 50 : 10;
      panelWidth = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : Math.max(bounds.min, Math.min(bounds.max, width + (event.key === 'ArrowRight' ? step : -step)));
      updatePanelWidth(); storePanelWidth();
    });
    window.addEventListener('resize', updatePanelWidth, { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updatePanelWidth).observe(document.querySelector('.cx-shell'));
    let measureFrame = 0;
    const scheduleMeasure = () => {
      cancelAnimationFrame(measureFrame);
      measureFrame = requestAnimationFrame(updatePanelWidth);
    };
    new MutationObserver(scheduleMeasure).observe($('cxTree'), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    $('cxPagesToggle').addEventListener('click', scheduleMeasure);
    if (document.fonts) {
      document.fonts.ready.then(scheduleMeasure);
      document.fonts.addEventListener('loadingdone', scheduleMeasure);
    }
    updatePanelWidth();
  }

  // ---------- wiring ----------
  function wire() {
    wirePanelResize();
    // Mobile keyboards can shrink the visual viewport without changing 100vh/100dvh.
    const measureDialogViewport = () => {
      const viewport = window.visualViewport;
      document.body.style.setProperty('--cx-dialog-height', (viewport ? viewport.height : window.innerHeight) + 'px');
      document.body.style.setProperty('--cx-dialog-top', (viewport ? viewport.offsetTop : 0) + 'px');
    };
    window.addEventListener('resize', measureDialogViewport, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', measureDialogViewport, { passive: true });
      window.visualViewport.addEventListener('scroll', measureDialogViewport, { passive: true });
    }
    measureDialogViewport();
    // Sticky controls and scroll targets track wrapped toolbars and the responsive site header.
    const measureScrollChrome = () => {
      const main = $('codexMain'), nav = document.querySelector('nav[data-site-navigation]');
      main.style.setProperty('--cx-nav-height', (nav ? nav.getBoundingClientRect().height : 64) + 'px');
      main.style.setProperty('--cx-view-height', document.querySelector('.cx-views').getBoundingClientRect().height + 'px');
      main.style.setProperty('--cx-toolbar-height', $('cxToolbar').getBoundingClientRect().height + 'px');
    };
    if (typeof ResizeObserver !== 'undefined') {
      const scrollChrome = new ResizeObserver(measureScrollChrome);
      [document.querySelector('nav[data-site-navigation]'), document.querySelector('.cx-views'), $('cxToolbar')]
        .filter(Boolean).forEach(element => scrollChrome.observe(element));
    }
    window.addEventListener('resize', measureScrollChrome, { passive: true });
    measureScrollChrome();
    $('cxToolbar').addEventListener('click', event => { const btn = event.target.closest('[data-cmd]'); if (btn && current && !btn.disabled) commands[btn.dataset.cmd](); });
    $('cxToolbar').addEventListener('mousedown', event => { if (event.target.closest('[data-cmd]')) event.preventDefault(); });
    // A file dropped on a page the reader cannot edit does nothing, rather than the browser opening it in place of the Codex.
    const refuseFiles = event => { if (!canEdit() && event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; } };
    $('cxEditor').addEventListener('dragover', refuseFiles);
    $('cxEditor').addEventListener('drop', refuseFiles);
    const bubble = $('cxBubble');
    bubble.addEventListener('mousedown', event => event.preventDefault());
    bubble.addEventListener('click', event => {
      const btn = event.target.closest('[data-bubble]');
      if (!btn || btn.disabled) return;
      ({ task: openTaskDialog, shot: () => { const info = selectionInfo(); hideBubble(); board.createFromSelection(info); }, page: () => openPageDialog(true), bold: commands.bold, italic: commands.italic, link: openLinkDialog })[btn.dataset.bubble]();
    });
    const surface = $('cxEditor');
    surface.addEventListener('contextmenu', event => {
      if (!canEdit() || !selectionInfo()) return;
      event.preventDefault();
      showBubble({ x: event.clientX, y: event.clientY });
    });
    surface.addEventListener('click', event => {
      const mention = event.target.closest('.cx-mention[data-id]');
      if (mention) { event.preventDefault(); if (pageById(mention.dataset.id)) openPage(mention.dataset.id); else announce('That page is private or was deleted.'); return; }
      const link = event.target.closest('a[href]');
      if (link && (event.ctrlKey || event.metaKey)) { event.preventDefault(); window.open(link.href, '_blank', 'noopener'); }
    });
    document.addEventListener('mousedown', event => { if (!bubble.contains(event.target) && !surface.contains(event.target)) hideBubble(); });
    window.addEventListener('scroll', () => { if (!bubble.hidden) showBubble(); }, { passive: true });

    $('cxTitle').addEventListener('input', () => { markDirty(); renderCrumb(); });
    $('cxTitle').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); editor.commands.focus('start'); } });
    $('cxType').addEventListener('change', () => { current.pageType = $('cxType').value; markDirty(); });
    $('cxSearch').addEventListener('input', () => {
      const searching = !!$('cxSearch').value.trim();
      $('cxCollapsePages').disabled = searching; $('cxExpandPages').disabled = searching;
      clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250);
    });
    $('cxPagesToggle').addEventListener('click', () => {
      browserCollapsed = !browserCollapsed; updatePageBrowser(); storeTreePreferences();
    });
    $('cxCollapsePages').addEventListener('click', () => setAllBranches(false));
    $('cxExpandPages').addEventListener('click', () => setAllBranches(true));
    $('cxNewPage').addEventListener('click', () => openPageDialog(false));
    $('cxFirstPage').addEventListener('click', () => openPageDialog(false));
    $('cxTabTasks').addEventListener('click', () => selectTab('tasks'));
    $('cxTabLinks').addEventListener('click', () => selectTab('links'));
    [$('cxTabTasks'), $('cxTabLinks')].forEach(tab => tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = tab.id === 'cxTabTasks' ? 'links' : 'tasks'; selectTab(next); $(next === 'tasks' ? 'cxTabTasks' : 'cxTabLinks').focus();
    }));
    $('cxViewWrite').addEventListener('click', () => showView('write'));
    $('cxViewBoard').addEventListener('click', () => showView('board'));
    [$('cxViewWrite'), $('cxViewBoard')].forEach(tab => tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = tab.id === 'cxViewWrite' ? 'board' : 'write'; showView(next); $(next === 'board' ? 'cxViewBoard' : 'cxViewWrite').focus();
    }));
    $('cxRefresh').addEventListener('click', refreshAnchors);
    window.addEventListener('focus', refreshAnchors);

    $('cxTaskForm').addEventListener('submit', submitTask);
    $('cxTaskCancel').addEventListener('click', () => closeBackdrop('cxTaskBackdrop'));
    $('cxPageForm').addEventListener('submit', submitPage);
    $('cxPageCancel').addEventListener('click', () => closeBackdrop('cxPageBackdrop'));
    $('cxLinkForm').addEventListener('submit', submitLink);
    $('cxLinkCancel').addEventListener('click', () => closeBackdrop('cxLinkBackdrop'));
    $('cxLinkRemove').addEventListener('click', () => { closeBackdrop('cxLinkBackdrop'); editor.chain().focus().extendMarkRange('link').unsetLink().run(); });
    $('cxShare').addEventListener('click', openShareDialog);
    $('cxShareFind').addEventListener('input', renderPeople);
    $('cxShareForm').addEventListener('submit', event => { event.preventDefault(); if ($('cxSharePerson').value) putShare($('cxSharePerson').value, $('cxShareAccess').value); });
    $('cxShareClose').addEventListener('click', () => closeBackdrop('cxShareBackdrop'));
    ['cxTaskBackdrop', 'cxPageBackdrop', 'cxLinkBackdrop', 'cxShareBackdrop'].forEach(id => {
      $(id).addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeBackdrop(id); return; }
        if (event.key !== 'Tab') return;
        const controls = [...$(id).querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      $(id).addEventListener('mousedown', event => { if (event.target === $(id)) closeBackdrop(id); });
    });

    $('cxReload').addEventListener('click', () => { conflict = false; dirty = false; openPage(current.id, null, { reload: true, discard: true }); });
    $('cxOverwrite').addEventListener('click', async () => {
      try {
        const latest = await api('/pages/' + current.id);
        current.version = latest.page.version;
        conflict = false; $('cxConflict').hidden = true; dirty = true;
        await save();
      } catch (error) { setSave(error.message, true); }
    });

    $('cxParent').addEventListener('change', () => movePage($('cxParent').value || null, childrenOf($('cxParent').value || null).filter(p => p.id !== current.id).length));
    $('cxMoveUp').addEventListener('click', () => shiftPage(-1));
    $('cxMoveDown').addEventListener('click', () => shiftPage(1));
    $('cxPageMenu').addEventListener('toggle', () => { if ($('cxPageMenu').open && current) { fillParentSelect($('cxParent'), current.parentId || '', current.id, pageById(rootId)?.ownerId); updateMoveButtons(); } });
    $('cxDelete').addEventListener('click', deletePage);

    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (dirty) save(); }
    });
    window.addEventListener('beforeunload', event => {
      if (!dirty || !current) return;
      const body = bodyFor(current.version);
      if (!conflict && body.title) fetch(apiRoot + '/pages/' + current.id, { method: 'PUT', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
      event.preventDefault(); event.returnValue = '';
    });
  }
  function siblingsOfCurrent() { return childrenOf(current.parentId || null); }
  function updateMoveButtons() {
    const siblings = siblingsOfCurrent(), at = siblings.findIndex(p => p.id === current.id);
    $('cxMoveUp').disabled = at <= 0; $('cxMoveDown').disabled = at < 0 || at >= siblings.length - 1;
  }
  async function movePage(parentId, index) {
    try {
      await api('/pages/' + current.id + '/move', { method: 'POST', body: { parentId, index } });
      current.parentId = parentId;
      await reloadTree(); revealPageBranch(current.id); renderTree(true); renderCrumb();
      fillParentSelect($('cxParent'), current.parentId || '', current.id, pageById(rootId)?.ownerId); updateMoveButtons();
    } catch (error) { announce(error.message); setSave(error.message, true); }
  }
  function shiftPage(delta) {
    const siblings = siblingsOfCurrent(), at = siblings.findIndex(p => p.id === current.id);
    if (at < 0 || at + delta < 0 || at + delta >= siblings.length) return;
    movePage(current.parentId || null, at + delta);
  }
  async function deletePage() {
    if (!current) return;
    if (childrenOf(current.id).length) { announce('Move or delete its sub-pages first.'); setSave('Move or delete its sub-pages first.', true); return; }
    const ok = await window.MobvisionConfirm.ask({ kicker: 'Codex', title: 'Delete “' + current.title + '”?',
      body: anchors.length ? 'Its ' + anchors.length + ' board task(s) stay on the board but lose their link to this page. Mentions of it elsewhere stop working.' : 'Mentions of it on other pages stop working.',
      confirmLabel: 'Delete page' });
    if (!ok) return;
    if (dirty && !(await save())) return;
    try {
      await api('/pages/' + current.id + '?version=' + current.version, { method: 'DELETE' });
      const parent = current.parentId;
      current = null; dirty = false;
      await reloadTree();
      if (parent && pageById(parent)) openPage(parent); else showFirstPage();
    } catch (error) { setSave(error.message, true); }
  }

  // ---------- start ----------
  async function start() {
    const access = $('cxAccess');
    let allowed = false;
    try {
      const res = await fetch(apiRoot + '/access', { credentials: 'include', headers: { Accept: 'application/json' } });
      if (res.status === 401) {
        access.lastElementChild.textContent = 'Sign in to open the Codex.';
        access.append(Object.assign(node('a', 'btn-primary', 'Sign in'), { href: '/auth/signin?returnUrl=/codex.html' }));
        return;
      }
      const answer = res.ok ? await res.json() : null;
      allowed = !!answer && answer.allowed === true;
      staff = allowed && answer.staff === true;
    } catch (_) { access.lastElementChild.textContent = 'The Codex is not reachable right now. Try again in a moment.'; return; }
    if (!allowed) { access.lastElementChild.textContent = 'The Codex did not open for this account. Reload the page.'; return; }
    $('cxViewBoard').hidden = !staff;
    if ($('cxCoverage')) $('cxCoverage').hidden = !staff;
    if (!kit) { access.lastElementChild.textContent = 'The editor did not load. Reload the page.'; return; }

    board = window.CodexStoryboard({ $, node, kindChip, announce, api, save, markDirty, pageById, timeLabel, canEdit,
      editor: () => editor, pages: () => pages, isDirty: () => dirty, refreshBadges: () => editor.commands.refreshBadges(),
      flash, showWrite: () => showView('write'), showBoard: () => showView('board'),
      openShot: (id, shotId) => openPage(id).then(() => { if (current && current.id === id) { showView('board'); board.focusCard(shotId); } }) });
    genImage = window.CodexGenImage({ $, node, api, announce, setSave, canEdit, editor: () => editor, isLoading: () => loadingPage,
      openBackdrop, closeBackdrop, staff });
    genImage.ready.then(applyAccess);
    editor = kit.createCodexEditor({
      element: $('cxEditor'),
      placeholder: staff ? 'Write. Type @ to mention a page. Select text to make a task or a shot.' : 'Write. Type @ to mention a page.',
      suggestion,
      renderBadge,
      renderShot: id => board.badge(id),
      onFiles: (files, pos) => { placeFiles(files, pos); },
      mountGenImage: (el, attrs) => genImage.mount(el, attrs),
      onUpdate: () => { markDirty(); board.textChanged(); if (!$('cxBubble').hidden) showBubble(); },
      onSelectionUpdate: () => { updateToolbar(); showBubble(); },
      onBlur: () => setTimeout(() => { if (!editor.isFocused && document.activeElement && !$('cxBubble').contains(document.activeElement)) hideBubble(); }, 0),
    });
    editor.on('transaction', updateToolbar);
    wire();
    try { await reloadTree(); }
    catch (error) { access.lastElementChild.textContent = error.message; return; }
    access.hidden = true; $('cxContent').hidden = false;
    updatePanelWidth();
    ensureTeam().then(() => { if (current) renderPanels(); });
    const params = new URL(location.href).searchParams, requested = params.get('page');
    if (requested && pageById(requested)) openPage(requested, params.get('block'));
    else { if (requested) announce('That page is not available: it was deleted or is no longer shared with you.'); showFirstPage(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
