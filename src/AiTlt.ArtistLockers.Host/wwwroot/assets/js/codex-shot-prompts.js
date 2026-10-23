/* A storyboard concept stays shared; each model owns its own editable prompt. */
(function (root) {
  'use strict';
  function init(shot, model) {
    shot.concept = shot.concept || '';
    if (!shot.prompts) {
      shot.prompts = {};
      if (shot.prompt) shot.prompts[model] = { prompt: shot.prompt, concept: shot.concept, language: 'en' };
    }
    return shot.prompts[model];
  }
  function text(draft) { return draft ? (draft.language === 'zh' ? draft.promptZh || '' : draft.prompt || '') : ''; }
  function select(shot, model) { shot.prompt = text(shot.prompts[model]); }
  function edit(shot, model, value) {
    const draft = init(shot, model) || { prompt: '', language: 'en' };
    if (draft.language === 'zh') { draft.promptZh = value; draft.conceptZh = shot.concept.trim(); }
    else { draft.prompt = value; draft.concept = shot.concept.trim(); }
    shot.prompts[model] = draft;
    shot.prompt = value;
  }
  function prepare(shot, model, en, zh, concept) {
    const language = zh && shot.prompts[model]?.language === 'zh' ? 'zh' : 'en';
    shot.prompts[model] = { prompt: en, promptZh: zh || null, concept: concept.trim(), conceptZh: zh ? concept.trim() : null, language };
    select(shot, model);
  }
  function stale(shot, model) {
    const draft = init(shot, model);
    return !!draft && (draft.language === 'zh' ? draft.conceptZh : draft.concept) !== shot.concept.trim();
  }
  const api = { init, text, select, edit, prepare, stale };
  root.CodexShotPrompts = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
