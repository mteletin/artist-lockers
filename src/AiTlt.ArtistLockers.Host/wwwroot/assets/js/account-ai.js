/* Tools → AI zone: the MCP connection card (its list and revoke live in tools.js) and the user's own
   provider keys. The tab appears only once the operator gate passes; the server refuses the same routes
   to anyone else. A key is write-only: the page sends it once and afterwards only sees its name and last four.
   The providers come from the server, so a new one shows up here without a page change. */
(function () {
  'use strict';

  var Gen = window.MvGen;
  var zone = document.querySelector('#aiZone');
  var list = document.querySelector('#apiKeyList');
  var status = document.querySelector('#apiKeyStatus');
  var addButton = document.querySelector('#apiKeyAdd');
  var addForm = document.querySelector('#apiKeyAddForm');
  if (!Gen || !zone || !list) return;

  var escapeHtml = Gen.escapeHtml;
  var started = false;
  var providers = [];
  var keys = [];
  // The one row whose Rename or Replace form is open: { id, mode }.
  var editing = null;

  function setStatus(text, isError) {
    if (!status) return;
    status.textContent = text || '';
    status.classList.toggle('is-error', !!isError);
  }

  function formatDate(value) {
    if (!value) return '';
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  async function request(method, path, body) {
    var response = await fetch('/api/v1/tools/keys' + path, {
      method: method,
      credentials: 'include',
      headers: body
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var payload = null;
    try { payload = await response.json(); } catch (err) { payload = null; }
    if (!response.ok) throw new Error((payload && payload.error) || 'The key service is unavailable.');
    return payload;
  }

  function providerById(id) {
    for (var i = 0; i < providers.length; i++) if (providers[i].id === id) return providers[i];
    return { id: id, label: id, description: '', keyUrl: '', maxKeys: 0 };
  }

  function keysOf(providerId) {
    return keys.filter(function (k) { return k.provider === providerId; });
  }

  function keyUrlLink(provider) {
    return provider.keyUrl
      ? ' <a href="' + escapeHtml(provider.keyUrl) + '" target="_blank" rel="noopener">Get a key from ' +
          escapeHtml(provider.label) + '</a>'
      : '';
  }

  function editForm(key, mode) {
    var rename = mode === 'rename';
    return '<form class="agent-secret-row api-key-edit" data-mode="' + mode + '" autocomplete="off">' +
      (rename
        ? '<input type="text" name="label" maxlength="60" value="' + escapeHtml(key.label) + '" aria-label="Key name">'
        : '<input type="password" name="key" autocomplete="off" spellcheck="false" maxlength="512" ' +
            'placeholder="Paste the new key" aria-label="New key">') +
      '<button class="btn-primary" type="submit">' + (rename ? 'Rename' : 'Replace') + '</button>' +
      '<button class="btn-secondary" type="button" data-action="cancel">Cancel</button>' +
    '</form>';
  }

  function keyRow(key, provider) {
    var facts = ['Saved ' + formatDate(key.updatedAt || key.createdAt)];
    facts.push(key.lastUsedAt ? 'last used ' + formatDate(key.lastUsedAt) : 'not used yet');
    var open = editing && editing.id === key.id ? editing.mode : null;
    return '<div class="api-key-row' + (key.isDefault ? ' is-default' : '') + '" data-key-id="' + escapeHtml(key.id) + '">' +
      '<div class="api-key-head">' +
        '<div><strong>' + escapeHtml(key.label) + '</strong>' +
          (key.isDefault ? ' <span class="track-chip is-approved-chip api-key-default">Default</span>' : '') +
          ' <span class="track-chip">' + (key.enabled ? 'On' : 'Off') + '</span>' +
          '<span class="api-key-facts">' + escapeHtml(facts.join(' · ')) + '</span></div>' +
        '<code class="api-key-mask">••••' + escapeHtml(key.last4) + '</code>' +
      '</div>' +
      (key.rejectedAt
        ? '<p class="api-key-rejected">' + escapeHtml(provider.label) + ' rejected this key on ' +
            escapeHtml(formatDate(key.rejectedAt)) + '. Replace it to use the models again.</p>'
        : '') +
      (open
        ? editForm(key, open)
        : '<div class="api-key-actions">' +
            '<button class="btn-secondary" type="button" data-action="toggle" aria-pressed="' + !!key.enabled + '">' +
              (key.enabled ? 'Disable' : 'Enable') + '</button>' +
            (key.isDefault ? '' : '<button class="btn-secondary" type="button" data-action="default">Make default</button>') +
            '<button class="btn-secondary" type="button" data-action="rename">Rename</button>' +
            '<button class="btn-secondary" type="button" data-action="replace">Replace</button>' +
            '<button class="btn-secondary" type="button" data-action="delete">Delete</button>' +
          '</div>') +
    '</div>';
  }

  function providerGroup(provider) {
    var own = keysOf(provider.id);
    return '<article class="api-key-card" data-provider="' + escapeHtml(provider.id) + '">' +
      '<div class="api-key-head">' +
        '<div><strong>' + escapeHtml(provider.label) + '</strong>' +
          '<span>' + escapeHtml(provider.description) + keyUrlLink(provider) + '</span></div>' +
        '<span class="api-key-count">' + own.length + ' of ' + provider.maxKeys + ' keys</span>' +
      '</div>' +
      (own.length
        ? '<p class="api-key-note">Enable the default key to use these models in the video tool and MCP. Switching off pauses waiting renders; renders already sent finish.</p>' +
          own.map(function (k) { return keyRow(k, provider); }).join('')
        : '<p class="api-key-none">No key saved. Add and enable one to use the ' + escapeHtml(provider.label) + ' models.</p>') +
    '</article>';
  }

  function render() {
    list.innerHTML = providers.length
      ? providers.map(providerGroup).join('')
      : '<div class="admin-empty">No provider takes a personal key yet.</div>';
    if (addButton) addButton.hidden = !providers.length;
  }

  async function load() {
    try {
      var data = await request('GET', '');
      providers = data.providers || [];
      keys = data.keys || [];
      render();
      fillProviderSelect();
    } catch (err) {
      list.innerHTML = '<div class="admin-empty">' + escapeHtml(err.message) + '</div>';
      if (addButton) addButton.hidden = true;
    }
  }

  // The video tool requires an enabled default key, so it re-reads its limits after a toggle too.
  function announce() {
    document.dispatchEvent(new CustomEvent('mv:api-keys-changed'));
  }

  // ── adding a key ──────────────────────────────────────────────────────────

  function fillProviderSelect() {
    if (!addForm) return;
    var select = addForm.elements.provider;
    var previous = select.value;
    select.innerHTML = providers.map(function (p) {
      var full = keysOf(p.id).length >= p.maxKeys;
      return '<option value="' + escapeHtml(p.id) + '"' + (full ? ' disabled' : '') + '>' +
        escapeHtml(p.label) + (full ? ' (full)' : '') + '</option>';
    }).join('');
    if (previous) select.value = previous;
    if (!select.value || select.selectedOptions[0].disabled) {
      var free = providers.filter(function (p) { return keysOf(p.id).length < p.maxKeys; })[0];
      if (free) select.value = free.id;
    }
    // One provider needs no choosing.
    addForm.querySelector('.api-key-provider-field').hidden = providers.length < 2;
    describeProvider();
  }

  function describeProvider() {
    if (!addForm) return;
    var hint = addForm.querySelector('.api-key-provider-hint');
    var provider = providerById(addForm.elements.provider.value);
    hint.innerHTML = escapeHtml(provider.description) + keyUrlLink(provider);
  }

  function showAddForm(show) {
    if (!addForm) return;
    addForm.hidden = !show;
    if (addButton) addButton.hidden = show || !providers.length;
    if (show) {
      addForm.reset();
      fillProviderSelect();
      addForm.elements.key.focus();
    }
  }

  if (addButton) addButton.addEventListener('click', function () { showAddForm(true); });

  if (addForm) {
    addForm.elements.provider.addEventListener('change', describeProvider);
    addForm.addEventListener('click', function (event) {
      if (event.target.closest('[data-action="cancel-add"]')) showAddForm(false);
    });
    addForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      var provider = addForm.elements.provider.value;
      var value = (addForm.elements.key.value || '').trim();
      if (!provider) {
        setStatus('Every provider already holds its most keys.', true);
        return;
      }
      if (!value) {
        setStatus('Paste a key first.', true);
        return;
      }
      setStatus('Saving...');
      try {
        await request('POST', '', { provider: provider, label: addForm.elements.label.value, key: value });
        setStatus('Key saved, switched off. Enable it when you want to use it.');
        showAddForm(false);
        await load();
        announce();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  }

  // ── a saved key's actions ─────────────────────────────────────────────────

  function keyOf(element) {
    var row = element.closest('[data-key-id]');
    if (!row) return null;
    for (var i = 0; i < keys.length; i++) if (keys[i].id === row.dataset.keyId) return keys[i];
    return null;
  }

  async function patch(key, body, done) {
    setStatus('Saving...');
    try {
      await request('PATCH', '/' + encodeURIComponent(key.id), body);
      editing = null;
      setStatus(done);
      await load();
      announce();
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  list.addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var key = keyOf(button);
    if (!key) return;
    var action = button.dataset.action;
    var provider = providerById(key.provider);

    if (action === 'rename' || action === 'replace') {
      editing = { id: key.id, mode: action };
      render();
      var input = list.querySelector('[data-key-id="' + key.id + '"] input');
      if (input) { input.focus(); if (input.select) input.select(); }
      return;
    }
    if (action === 'cancel') {
      editing = null;
      render();
      return;
    }
    if (action === 'default') {
      await patch(key, { makeDefault: true }, key.label + ' is now the default ' + provider.label + ' key.');
      return;
    }
    if (action === 'toggle') {
      button.disabled = true;
      try {
        await patch(key, { enabled: !key.enabled }, key.label + (key.enabled ? ' is off.' : ' is on.'));
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'delete') {
      var others = keysOf(key.provider).length - 1;
      var consequence = !others
        ? ' The ' + provider.label + ' models disappear from the video tool until you add another.'
        : key.isDefault ? ' Your oldest other ' + provider.label + ' key becomes the default.' : '';
      if (!window.confirm('Delete the ' + provider.label + ' key "' + key.label + '"?' + consequence)) return;
      setStatus('Deleting...');
      try {
        await request('DELETE', '/' + encodeURIComponent(key.id));
        if (editing && editing.id === key.id) editing = null;
        setStatus('Key deleted.');
        await load();
        announce();
      } catch (err) {
        setStatus(err.message, true);
      }
    }
  });

  list.addEventListener('submit', async function (event) {
    var form = event.target.closest('.api-key-edit');
    if (!form) return;
    event.preventDefault();
    var key = keyOf(form);
    if (!key) return;
    if (form.dataset.mode === 'rename') {
      var label = (form.elements.label.value || '').trim();
      if (!label) {
        setStatus('Give the key a name.', true);
        return;
      }
      await patch(key, { label: label }, 'Key renamed.');
      return;
    }
    var value = (form.elements.key.value || '').trim();
    if (!value) {
      setStatus('Paste the new key first.', true);
      return;
    }
    await patch(key, { key: value }, 'Key replaced.');
  });

  async function start() {
    if (started) return;
    started = true;
    if (!await Gen.resolveRoles()) {
      zone.remove();
      return;
    }
    zone.hidden = false;
    if (typeof window.revealToolTab === 'function') window.revealToolTab('ai', false);
    await load();
  }

  Gen.onToolsOpen(start);
})();
