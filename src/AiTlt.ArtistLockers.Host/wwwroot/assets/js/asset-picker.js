/* Shared image picker over the account asset gallery (/api/v1/library/mine).
   Used by the account pages and by listen.html for party cover art.

   Usage:
     MobvisionAssetPicker.open({
       onPick: function (url) { ... },
       onUploadRequest: function (uploadTags) { ... },  // optional; Upload hidden when absent
       source: '/api/ed3/admin/assets',                 // optional; defaults to the account's own
       uploadTags: 'lore'                               // optional; handed to onUploadRequest
     });
     MobvisionAssetPicker.resolve(url);       // finish a pick from an external upload flow
     MobvisionAssetPicker.status(text, isError); MobvisionAssetPicker.busy(bool);  // feedback for that flow

   Markup is injected on first use, so a host page needs no picker HTML — only this script.
   Class names mirror the original account markup so existing CSS applies unchanged. */
(function () {
  'use strict';

  // Admin picks from the site-wide library, everyone else from their own uploads.
  var ACCOUNT_SOURCE = '/api/v1/library/mine';

  var backdrop = null, grid = null, filters = null, uploadBtn = null, statusLine = null;
  var assets = [];
  var activeTag = null;
  var onPick = null;
  var onUploadRequest = null;
  var uploadTags = null;
  var source = ACCOUNT_SOURCE;
  var kind = null;
  var lastFocus = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (backdrop) return;

    backdrop = el('div', 'upload-modal-backdrop picker-backdrop');
    backdrop.id = 'sharedAssetPickerBackdrop';

    var modal = el('div', 'upload-modal picker-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Choose a gallery reference');
    var header = el('div', 'upload-modal-header');
    header.appendChild(el('div', 'admin-section-heading', 'Choose Image'));

    var actions = el('div', 'picker-header-actions');
    uploadBtn = el('button', 'btn-ghost picker-upload-btn', '+ Upload');
    uploadBtn.type = 'button';
    uploadBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (onUploadRequest) onUploadRequest(uploadTags);
    });
    actions.appendChild(uploadBtn);

    var closeBtn = el('button', 'button-reset upload-modal-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', close);
    actions.appendChild(closeBtn);
    header.appendChild(actions);

    var body = el('div', 'upload-modal-body');
    statusLine = el('p', 'picker-status');
    statusLine.setAttribute('role', 'status');
    filters = el('div', 'asset-tag-filters');
    grid = el('div', 'assets-grid');
    header.insertBefore(statusLine, actions);
    body.appendChild(filters);
    body.appendChild(grid);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    filters.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-picker-tag]');
      if (!btn) return;
      activeTag = btn.dataset.pickerTag || null;
      renderFilters();
      renderGrid();
    });
    grid.addEventListener('click', function (e) {
      var card = e.target.closest('[data-picker-url]');
      if (card) resolve(card.dataset.pickerUrl);
    });
    grid.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-picker-url]')) {
        e.preventDefault(); resolve(e.target.dataset.pickerUrl);
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && backdrop.classList.contains('is-visible')) close();
      if (e.key === 'Tab' && backdrop.classList.contains('is-visible')) {
        var focusable = Array.from(modal.querySelectorAll('button,[tabindex="0"],audio,video')).filter(function (n) { return !n.disabled && n.getClientRects().length; });
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); if (last) last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); if (first) first.focus(); }
      }
    });
  }

  function renderFilters() {
    var seen = {};
    assets.forEach(function (a) { (a.tags || []).forEach(function (t) { seen[t] = true; }); });
    var tags = Object.keys(seen).sort();

    filters.textContent = '';
    var all = el('button', 'asset-tag-btn' + (activeTag ? '' : ' is-active'), 'All');
    all.type = 'button';
    all.dataset.pickerTag = '';
    filters.appendChild(all);

    tags.forEach(function (t) {
      var b = el('button', 'asset-tag-btn' + (activeTag === t ? ' is-active' : ''), t);
      b.type = 'button';
      b.dataset.pickerTag = t;
      filters.appendChild(b);
    });
  }

  function renderGrid() {
    var list = activeTag
      ? assets.filter(function (a) { return (a.tags || []).indexOf(activeTag) !== -1; })
      : assets;

    grid.textContent = '';
    if (!list.length) {
      grid.appendChild(el('div', 'admin-empty', 'No assets.'));
      return;
    }
    list.forEach(function (a) {
      var card = el('div', 'asset-card is-approved picker-asset');
      card.dataset.pickerUrl = a.url;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Choose ' + (a.filename || 'reference'));

      var thumb = el('div', 'picker-thumb');
      if (a.kind === 'audio') {
        var player = el('audio');
        player.controls = true;
        player.preload = 'none';
        player.src = a.url;
        player.style.width = '100%';
        player.addEventListener('click', function(e) { e.stopPropagation(); });
        thumb.appendChild(player);
      } else if (a.kind === 'video') {
        var video = el('video');
        video.src = a.url;
        video.controls = true;
        video.preload = 'metadata';
        video.style.width = '100%';
        video.addEventListener('click', function(e) { e.stopPropagation(); });
        thumb.appendChild(video);
      } else {
        var img = el('img');
        img.src = a.url;
        img.alt = a.filename || '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      }
      card.appendChild(thumb);

      var info = el('div', 'asset-info');
      info.appendChild(el('div', 'asset-filename', a.filename || ''));
      if (a.description) info.appendChild(el('div', 'asset-desc', a.description));
      info.appendChild(el('div', 'asset-tags', (a.tags || []).join(', ') || 'no tags'));
      card.appendChild(info);

      grid.appendChild(card);
    });
  }

  function load() {
    grid.textContent = '';
    grid.appendChild(el('div', 'admin-empty', 'Loading...'));
    var requestedSource=source, requestedKind=kind;
    return (async function(){
      var offset=0, all=[];
      while(true){
        var url=new URL(requestedSource,location.origin);url.searchParams.set('limit','200');url.searchParams.set('offset',String(offset));
        var response=await fetch(url,{credentials:'include',headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error('Assets unavailable.');
        var data=await response.json(),items=Array.isArray(data)?data:(data.items||[]);all=all.concat(items);
        if(!data.hasMore||!items.length)break;offset+=items.length;
      }
      if(source!==requestedSource||kind!==requestedKind)return;
      assets=all.filter(function(asset){return !kind||asset.kind===kind||(!asset.kind&&kind==='image'&&/^image\//.test(asset.contentType||''));});
      renderFilters();renderGrid();
    })()
      .catch(function () {
        grid.textContent = '';
        grid.appendChild(el('div', 'admin-empty', 'Assets unavailable.'));
      });
  }

  function open(options) {
    build();
    lastFocus = document.activeElement;
    options = options || {};
    onPick = typeof options.onPick === 'function' ? options.onPick : null;
    onUploadRequest = typeof options.onUploadRequest === 'function' ? options.onUploadRequest : null;
    uploadTags = options.uploadTags || null;
    source = options.source || ACCOUNT_SOURCE;
    kind = options.kind || null;
    backdrop.querySelector('.admin-section-heading').textContent = options.title || (kind === 'audio' ? 'Choose Audio' : 'Choose Image');
    uploadBtn.hidden = !onUploadRequest;
    uploadBtn.disabled = false;
    setStatus('');
    activeTag = null;
    backdrop.classList.add('is-visible');
    backdrop.querySelector('.upload-modal-close').focus();
    return load();
  }

  function close() {
    if (backdrop) backdrop.classList.remove('is-visible');
    onPick = null;
    onUploadRequest = null;
    uploadTags = null;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }

  /// Completes a pick — also used by a host page's own upload flow once it has a URL.
  function resolve(url) {
    var cb = onPick;
    var asset = assets.find(function (a) { return a.url === url; });
    close();
    if (cb && url) cb(url, asset);
  }

  /// A line under the title for a host's upload flow: progress, or an error when isError is set.
  function setStatus(text, isError) {
    if (!statusLine) return;
    statusLine.textContent = text || '';
    statusLine.classList.toggle('is-error', !!isError);
  }

  /// Disables Upload while a host's upload runs.
  function setBusy(busy) {
    if (uploadBtn) uploadBtn.disabled = !!busy;
  }

  window.MobvisionAssetPicker = { open: open, close: close, resolve: resolve, reload: load, status: setStatus, busy: setBusy };
})();
