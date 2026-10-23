/* The generation models as the studios see them: the rows /api/ed3/h3/limits returns under `models`,
   each carrying its spec (provider, seconds, resolutions, aspects, per-rail maxima, seed). The Video
   Generation studio and the Codex storyboard both shape their controls from here instead of naming a
   model. Mirrors GenModels / SeedanceGrid in backend/Models/GenModels.cs. */
(function () {
  'use strict';

  var LOCAL = 'local';
  var H3 = 'minimax-h3';

  var PROVIDER_LABELS = { local: 'our GPUs', seevio: 'Seevio' };

  // SeedanceGrid.Aspects, with the words the size menu uses.
  var ASPECTS = [
    { name: '16:9', w: 16, h: 9, label: 'Landscape 16:9' },
    { name: '9:16', w: 9, h: 16, label: 'Portrait 9:16' },
    { name: '1:1', w: 1, h: 1, label: 'Square 1:1' },
    { name: '4:3', w: 4, h: 3, label: 'Classic 4:3' },
    { name: '3:4', w: 3, h: 4, label: 'Classic portrait 3:4' },
    { name: '21:9', w: 21, h: 9, label: 'Wide 21:9' }
  ];

  /** The enabled models of a kind ('video' / 'image'), in the admin's order. */
  function list(limits, kind) {
    return ((limits && limits.models) || []).filter(function (model) {
      return model.enabled && (!kind || model.kind === kind);
    }).map(function (model) {
      seenProviders[model.id] = model.provider || LOCAL;
      return model;
    }).sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
  }

  function find(limits, id) {
    return list(limits).filter(function (model) { return model.id === id; })[0] || null;
  }

  function isCloud(model) {
    return !!model && !!model.provider && model.provider !== LOCAL;
  }

  // Every model id a list has shown with its provider, so a job can be labelled even after its model left the
  // picker (a deleted key hides the Seevio models, not their jobs).
  var seenProviders = {};

  /** The provider of a job's model, from the lists seen so far; Seedance ids are always Seevio's. */
  function jobProvider(job) {
    var id = job && job.model;
    if (!id) return LOCAL;
    if (seenProviders[id]) return seenProviders[id];
    return id.indexOf('seedance') === 0 ? 'seevio' : LOCAL;
  }

  function isCloudJob(job) {
    return jobProvider(job) !== LOCAL;
  }

  function providerLabel(model) {
    var provider = (model && model.provider) || LOCAL;
    return PROVIDER_LABELS[provider] || provider;
  }

  function maxFor(model, rail) {
    if (!model) return 0;
    return rail === 'image' ? model.maxImages : rail === 'video' ? model.maxVideos : rail === 'audio' ? model.maxAudios : 0;
  }

  /** How a prompt names a reference for this model (GenModels.TagFor). */
  function tagFor(model, rail, slot) {
    var advisor = model && model.advisor;
    if (advisor === 'qwen-image') return '<image' + (slot + 1) + '>';
    var word = rail === 'image' ? 'Image' : rail === 'video' ? 'Video' : 'Audio';
    if (advisor === 'seedance') return word + ' ' + (slot + 1);
    return '<' + (rail === 'image' ? 'Picture' : word) + ' ' + (slot + 1) + '>';
  }

  function clampSeconds(model, seconds) {
    var n = Number(seconds);
    if (!(n > 0)) n = model.defaultSeconds || model.minSeconds || 5;
    return Math.min(model.maxSeconds || n, Math.max(model.minSeconds || 1, Math.round(n)));
  }

  function pickResolution(model, wanted) {
    var all = (model && model.resolutions) || [];
    if (all.indexOf(wanted) !== -1) return wanted;
    return (model && model.defaultResolution) || all[0] || '';
  }

  function aspects(model) {
    var names = (model && model.aspects) || [];
    return ASPECTS.filter(function (a) { return names.indexOf(a.name) !== -1; });
  }

  /** The supported ratio closest to width:height; 16:9 when either is missing (SeedanceGrid.AspectFor). */
  function aspectFor(width, height) {
    if (!(width > 0) || !(height > 0)) return '16:9';
    var wanted = Math.log(width / height);
    return ASPECTS.reduce(function (best, a) {
      return Math.abs(Math.log(a.w / a.h) - wanted) < Math.abs(Math.log(best.w / best.h) - wanted) ? a : best;
    }).name;
  }

  function resolutionFor(width, height) {
    return Math.min(width, height) + 'p';
  }

  /** The frame size of an aspect at a resolution, short side = the resolution's lines (SeedanceGrid.SizeFor). */
  function sizeFor(aspect, resolution) {
    var lines = parseInt(resolution, 10) || 720;
    var a = ASPECTS.filter(function (x) { return x.name === aspect; })[0] || ASPECTS[0];
    return a.w >= a.h
      ? { width: Math.round(lines * a.w / a.h / 2) * 2, height: lines }
      : { width: lines, height: Math.round(lines * a.h / a.w / 2) * 2 };
  }

  window.MvGenModels = {
    H3: H3,
    list: list,
    find: find,
    isCloud: isCloud,
    isCloudJob: isCloudJob,
    jobProvider: jobProvider,
    providerLabel: providerLabel,
    maxFor: maxFor,
    tagFor: tagFor,
    clampSeconds: clampSeconds,
    pickResolution: pickResolution,
    aspects: aspects,
    aspectFor: aspectFor,
    resolutionFor: resolutionFor,
    sizeFor: sizeFor
  };
})();
