/* Tools tab, second row: switches between the tool sub-panels (Audio Remaster, MiniMax H3, ...).
   Tools that are gated on a role start with their button hidden and call window.revealToolTab
   once the gate passes; the first tool revealed as a default wins unless the operator already
   clicked a sub-tab by hand. */
(function () {
  'use strict';

  var bar = document.querySelector('#toolsSubtabs');
  if (!bar) return;

  var chosenByUser = null;
  // tools.html#h3 (or #image, #remaster, #ai) opens that tool once it is shown; a pick by hand is kept the same way.
  var wanted = location.hash.replace('#', '').toLowerCase() || null;

  function tabFor(name) {
    return bar.querySelector('.tools-subtab[data-tool="' + name + '"]');
  }

  function select(name, byUser) {
    var tab = tabFor(name);
    if (!tab || tab.hidden) return false;

    bar.querySelectorAll('.tools-subtab').forEach(function (t) {
      var on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#panelTools .tools-subpanel').forEach(function (p) {
      p.classList.toggle('is-visible', p.dataset.toolPanel === name);
    });

    if (byUser) {
      chosenByUser = name;
      wanted = null;
      if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    }
    return true;
  }

  bar.addEventListener('click', function (e) {
    var btn = e.target.closest('.tools-subtab');
    if (!btn || !bar.contains(btn)) return;
    select(btn.dataset.tool, true);
  });

  /** Shows a gated tool's sub-tab; with makeDefault it also becomes the open tool if nothing was picked yet. */
  window.revealToolTab = function (name, makeDefault) {
    var tab = tabFor(name);
    if (!tab) return;
    tab.hidden = false;
    if (wanted === name) select(name, true);
    else if (makeDefault && !chosenByUser && !wanted) select(name, false);
  };

  window.selectToolTab = function (name) {
    return select(name, true);
  };

  window.addEventListener('hashchange', function () { wanted=location.hash.slice(1).toLowerCase(); if(wanted) select(wanted,true); });

  if (wanted) {
    var open = tabFor(wanted);
    if (open && !open.hidden) select(wanted, true);
  }
})();
