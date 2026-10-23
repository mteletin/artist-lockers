/* Shared confirmation dialog, styled like the rest of the site.
   Replaces window.confirm(), which renders as a raw browser alert and looks foreign.

   Usage:
     MobvisionConfirm.ask({
       kicker: 'Retract track',
       title: 'Retract this track?',
       body: 'It disappears from your library…',
       confirmLabel: 'Retract',
       danger: true
     }).then(function (ok) { if (ok) ... });

   Markup is injected on first use, so a page needs only this script. Class names mirror the
   existing nf-publish dialog so it inherits the same styling. */
(function () {
  'use strict';

  var backdrop = null, kickerEl, titleEl, bodyEl, confirmBtn, cancelBtn;
  var resolver = null;
  var lastFocus = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    if (backdrop) return;

    backdrop = el('div', 'upload-modal-backdrop nf-publish-backdrop');
    backdrop.id = 'sharedConfirmBackdrop';
    backdrop.setAttribute('role', 'presentation');

    var modal = el('div', 'upload-modal nf-publish-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    var head = el('div', 'nf-publish-head');
    kickerEl = el('span', 'nf-publish-kicker');
    titleEl = el('div', 'nf-publish-title');
    head.appendChild(kickerEl);
    head.appendChild(titleEl);

    var body = el('div', 'nf-publish-body');
    bodyEl = el('p', 'nf-publish-warning');
    body.appendChild(bodyEl);

    var actions = el('div', 'nf-publish-actions');
    cancelBtn = el('button', 'btn-ghost', 'Cancel');
    cancelBtn.type = 'button';
    confirmBtn = el('button', 'btn-danger', 'Confirm');
    confirmBtn.type = 'button';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    cancelBtn.addEventListener('click', function () { finish(false); });
    confirmBtn.addEventListener('click', function () { finish(true); });
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) finish(false); });
    document.addEventListener('keydown', function (e) {
      if (!backdrop.classList.contains('is-visible')) return;
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    });
  }

  function finish(answer) {
    backdrop.classList.remove('is-visible');
    var done = resolver;
    resolver = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    if (done) done(answer);
  }

  function ask(options) {
    build();
    options = options || {};

    kickerEl.textContent = options.kicker || 'Confirm';
    titleEl.textContent = options.title || 'Are you sure?';
    bodyEl.textContent = options.body || '';
    bodyEl.hidden = !options.body;
    confirmBtn.textContent = options.confirmLabel || 'Confirm';
    confirmBtn.className = options.danger === false ? 'btn-primary' : 'btn-danger';

    lastFocus = document.activeElement;
    backdrop.classList.add('is-visible');
    confirmBtn.focus();

    return new Promise(function (resolve) {
      // A second ask while one is open answers the first as cancelled.
      if (resolver) resolver(false);
      resolver = resolve;
    });
  }

  window.MobvisionConfirm = { ask: ask };
})();
