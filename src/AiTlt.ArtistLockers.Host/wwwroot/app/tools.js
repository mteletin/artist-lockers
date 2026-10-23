// The generation tools' shared parts: the /state poll, the queue bar, the GPU board, the job list, the results shelf, the
// reference picker and the model helpers. Video Generation and the Image Generator draw on one queue and the same per-member
// slots; each page shows its own kind of job. Ported from Mobvision's account-gen-shared.js and gen-models.js.
import { api } from "/ai-tlt/ui/v1/api.js";
import { h, mount, icon, empty } from "/ai-tlt/ui/v1/components.js";
import { formatDuration, formatSize, reportError } from "./util.js";

export const TOOLS = "/api/v1/tools";
export const MAX_PROMPT = 8000;
const POLL_LIVE_MS = 4000;
const POLL_IDLE_MS = 20000;
const LIVE = ["staged", "queued", "running"];

// ── models ──────────────────────────────────────────────────────────────

export const H3 = "minimax-h3";
const LOCAL = "local";
const PROVIDER_LABELS = { local: "our GPUs", seevio: "Seevio" };

// The cloud models' aspects, with the words the size menu uses.
export const ASPECTS = [
  { name: "16:9", w: 16, h: 9, label: "Landscape 16:9" },
  { name: "9:16", w: 9, h: 16, label: "Portrait 9:16" },
  { name: "1:1", w: 1, h: 1, label: "Square 1:1" },
  { name: "4:3", w: 4, h: 3, label: "Classic 4:3" },
  { name: "3:4", w: 3, h: 4, label: "Classic portrait 3:4" },
  { name: "21:9", w: 21, h: 9, label: "Wide 21:9" }
];

// Every model id a list has shown with its provider, so a job can be labelled after its model left the picker.
const seenProviders = {};

/** The enabled models of a kind ("video" / "image"), in the operator's order. */
export function modelList(limits, kind) {
  return (limits?.models || []).filter((model) => model.enabled && (!kind || model.kind === kind))
    .map((model) => { seenProviders[model.id] = model.provider || LOCAL; return model; })
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

export function findModel(limits, id) {
  return modelList(limits).find((model) => model.id === id) || null;
}

export function isCloud(model) {
  return !!model?.provider && model.provider !== LOCAL;
}

/** A job's provider, from the lists seen so far; Seedance ids are always Seevio's. */
function jobProvider(job) {
  const id = job?.model;
  if (!id) return LOCAL;
  return seenProviders[id] || (id.startsWith("seedance") ? "seevio" : LOCAL);
}

export function isCloudJob(job) {
  return jobProvider(job) !== LOCAL;
}

export function providerLabel(model) {
  const provider = model?.provider || LOCAL;
  return PROVIDER_LABELS[provider] || provider;
}

export function modelMax(model, rail) {
  if (!model) return 0;
  return rail === "image" ? model.maxImages : rail === "video" ? model.maxVideos : rail === "audio" ? model.maxAudios : 0;
}

/** How a prompt names a reference for this model. */
export function tagFor(model, rail, slot) {
  const advisor = model?.advisor;
  if (advisor === "qwen-image") return `<image${slot + 1}>`;
  const word = rail === "image" ? "Image" : rail === "video" ? "Video" : "Audio";
  if (advisor === "seedance") return `${word} ${slot + 1}`;
  return `<${rail === "image" ? "Picture" : word} ${slot + 1}>`;
}

export function clampSeconds(model, seconds) {
  let n = Number(seconds);
  if (!(n > 0)) n = model.defaultSeconds || model.minSeconds || 5;
  return Math.min(model.maxSeconds || n, Math.max(model.minSeconds || 1, Math.round(n)));
}

export function pickResolution(model, wanted) {
  const all = model?.resolutions || [];
  return all.includes(wanted) ? wanted : model?.defaultResolution || all[0] || "";
}

export function modelAspects(model) {
  const names = model?.aspects || [];
  return ASPECTS.filter((a) => names.includes(a.name));
}

/** The supported ratio closest to width:height; 16:9 when either is missing. */
export function aspectFor(width, height) {
  if (!(width > 0) || !(height > 0)) return "16:9";
  const wanted = Math.log(width / height);
  return ASPECTS.reduce((best, a) => Math.abs(Math.log(a.w / a.h) - wanted) < Math.abs(Math.log(best.w / best.h) - wanted) ? a : best).name;
}

export function resolutionFor(width, height) {
  return `${Math.min(width, height)}p`;
}

/** The frame size of an aspect at a resolution: the short side is the resolution's lines. */
export function sizeFor(aspect, resolution) {
  const lines = parseInt(resolution, 10) || 720;
  const a = ASPECTS.find((x) => x.name === aspect) || ASPECTS[0];
  return a.w >= a.h
    ? { width: Math.round(lines * a.w / a.h / 2) * 2, height: lines }
    : { width: lines, height: Math.round(lines * a.h / a.w / 2) * 2 };
}

// ── wording ─────────────────────────────────────────────────────────────

export function isImageJob(job) {
  return (job?.kind || "video") === "image";
}

/** Sampler progress as 0..100, or null while the worker has not reported a step yet. */
function progressPercent(item) {
  if (!(item?.progressMax > 0)) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (item.progressValue || 0) / item.progressMax)));
}

export function statusLabel(job) {
  // A cloud job waits on its provider's own line, never in the GPU queue, and reports no steps.
  if (isCloudJob(job)) {
    const at = ` at ${providerLabel({ provider: jobProvider(job) })}`;
    if (job.status === "queued") return `Waiting${at}`;
    if (job.status === "running") return `Rendering${at}`;
  }
  if (job.status === "staged") return `Backlog #${job.stageOrder}`;
  if (job.status === "queued") return job.queuePosition ? `Queued #${job.queuePosition}` : "Queued";
  if (job.status === "running") {
    const pct = progressPercent(job);
    // Past the last sampler step the decode and the encode still run; they have no step count.
    const phase = pct === null ? "Rendering" : pct >= 100 ? "Finishing" : `Rendering ${pct}% · step ${job.progressValue}/${job.progressMax}`;
    return phase + (job.workerLabel ? ` on ${job.workerLabel}` : "");
  }
  return { completed: "Done", failed: "Failed", cancelled: "Cancelled" }[job.status] || job.status;
}

/** "1280×704 · 5.2s" for a clip, "1024×1024" for a still. */
export function sizeLabel(job) {
  const size = `${job.width}×${job.height}`;
  return isImageJob(job) ? size : `${size} · ${Number(job.seconds || 0).toFixed(1)}s`;
}

/** "a of b slots in use · N waiting in your backlog · X of Y stored": both studios draw on the same slots. */
export function slotsText(limits, queue) {
  const parts = [`${queue?.myInFlight || 0} of ${limits.maxInFlightPerUser} slots in use`];
  if (queue?.myStaged) parts.push(`${queue.myStaged} waiting in your backlog`);
  if (limits.quotaBytesPerUser) parts.push(`${storage(limits.usedBytes)} of ${storage(limits.quotaBytesPerUser)} stored`);
  return parts.join(" · ");
}

function storage(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatSize(bytes || 0);
}

/** A seed as the page holds it: text, so 64-bit seeds stay exact. Blank means "pick one"; null means not a seed. */
export function seedText(value) {
  const text = String(value ?? "").trim();
  return text === "" || /^\d{1,19}$/.test(text) ? text : null;
}

// ── the state poll ──────────────────────────────────────────────────────

/** Polls /state while the page is current: every 4 s while anything is live, every 20 s otherwise. onState(state) gets
 *  { queue, jobs, shelf, gpus }; refresh() asks at once. */
export function statePoll(isCurrent, onState) {
  let timer = null;
  let running = null;
  async function tick() {
    clearTimeout(timer);
    if (!isCurrent()) return;
    let live = false;
    try {
      const state = await api.get(`${TOOLS}/state`);
      if (!isCurrent()) return;
      live = !!state.queue?.segments?.length || [...state.jobs, ...state.shelf].some((job) => LIVE.includes(job.status));
      onState(state);
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
    }
    if (isCurrent()) timer = setTimeout(refresh, live ? POLL_LIVE_MS : POLL_IDLE_MS);
  }
  function refresh() {
    if (!running) running = tick().finally(() => { running = null; });
    return running;
  }
  refresh();
  return { refresh };
}

// ── queue bar ───────────────────────────────────────────────────────────

/** The shared queue as anonymous segments; the member's own open to a line about the job. */
export function queueBar() {
  let selected = null;
  let last = { queue: null, jobs: [] };
  const count = h("span", { class: "ait-small ait-muted" });
  const bar = h("div", { class: "app-tool-queue", role: "group", "aria-label": "Render queue" });
  const detail = h("div", { class: "app-tool-queue-detail", hidden: true });
  const el = h("section", { class: "ait-card app-tool-card" },
    h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title", text: "Queue" }), count),
    h("div", { class: "app-tool-card-body" }, bar, detail));

  function render(queue, jobs) {
    last = { queue, jobs: jobs || [] };
    const segments = queue?.segments || [];
    const gpus = queue?.workerCount || 0;
    const gpuText = `${gpus} GPU${gpus === 1 ? "" : "s"}`;
    count.textContent = segments.length ? `${segments.length} in the queue · ${gpuText}` : `Idle · ${gpuText}`;
    if (!segments.length) {
      mount(bar, h("div", { class: "ait-small ait-faint", text: "Nothing rendering right now." }));
      selected = null;
      renderDetail();
      return;
    }
    mount(bar, segments.map(segment));
    renderDetail();
  }

  function segment(item) {
    const pct = progressPercent(item);
    let label = item.mine ? `Your job — position ${item.position}` : `Position ${item.position}`;
    const seg = h(item.mine ? "button" : "div", { class: `app-tool-seg${item.mine ? " is-mine" : ""}`, role: item.mine ? null : "img" });
    if (item.status === "running") {
      seg.classList.add("is-running");
      if (pct === null) {
        // Nothing from the sampler yet (models loading, references encoding): a sweep.
        seg.classList.add("is-warming");
        label += " · warming up";
      } else {
        const fill = h("span", { class: "app-tool-seg-fill" });
        fill.style.width = `${pct}%`;
        seg.append(fill);
        label += pct >= 100 ? " · finishing" : ` · ${pct}%`;
      }
    }
    if (item.mine) {
      seg.type = "button";
      seg.setAttribute("aria-pressed", String(item.id === selected));
      seg.addEventListener("click", () => { selected = selected === item.id ? null : item.id; render(last.queue, last.jobs); });
    }
    seg.setAttribute("aria-label", label);
    seg.title = label;
    return seg;
  }

  function renderDetail() {
    const job = selected && last.jobs.find((candidate) => candidate.id === selected);
    detail.hidden = !job;
    if (!job) { detail.replaceChildren(); return; }
    const meta = [statusLabel(job)];
    if (isImageJob(job)) meta.push(`image${job.mode ? ` · ${job.mode}` : ""}`);
    meta.push(sizeLabel(job));
    if (job.sampler) meta.push(`${job.runFlow === "fused" ? "fused · " : ""}${job.sampler} / ${job.scheduler} · ${job.steps} steps`);
    if (job.seed) meta.push(`seed ${job.seed}`);
    mount(detail, h("p", { class: "app-tool-prompt", text: job.prompt || "" }), h("div", { class: "ait-small ait-faint", text: meta.join(" · ") }));
  }

  return { el, render };
}

// ── GPU board ───────────────────────────────────────────────────────────
// Junction (hotspot) is the number that throttles, so it is the one shown; edge runs cooler and would look reassuring.

const GPU_WARM_C = 95;
const GPU_HOT_C = 105;

function gpuMode() {
  try { return localStorage.getItem("ait-gpu-mode") === "numbers" ? "numbers" : "bars"; } catch { return "bars"; }
}

function describeAge(seconds) {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** The GPUs' temperatures, load and memory, as bars or as numbers (the choice is per browser). Hidden when there are none. */
export function gpuBoard() {
  let last = null;
  const cards = h("div", { class: "app-tool-gpus", role: "list" });
  const toggle = (mode, label) => h("button", { class: "app-segment", type: "button", text: label, dataset: { mode },
    onClick: () => { try { localStorage.setItem("ait-gpu-mode", mode); } catch { /* the choice just won't persist */ } render(last); } });
  const modes = h("div", { class: "app-segments", role: "group", "aria-label": "Show as" }, toggle("bars", "Bars"), toggle("numbers", "Numbers"));
  const el = h("section", { class: "ait-card app-tool-card", hidden: true },
    h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title", text: "GPUs" }), modes),
    h("div", { class: "app-tool-card-body" }, cards));

  function render(view) {
    last = view;
    const list = view?.gpus || [];
    el.hidden = !list.length;
    if (!list.length) return;
    const numbers = gpuMode() === "numbers";
    modes.querySelectorAll("[data-mode]").forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.mode === (numbers ? "numbers" : "bars"))));
    mount(cards, list.map((card) => gpuCard(card, view, numbers)));
  }

  return { el, render };
}

function gpuCard(card, view, numbers) {
  const stale = !!view.stale;
  const junction = typeof card.junctionC === "number" ? Math.round(card.junctionC) : null;
  const limit = typeof card.junctionLimitC === "number" ? Math.round(card.junctionLimitC) : null;
  const busy = !stale && typeof card.busyPercent === "number" ? Math.round(card.busyPercent) : null;
  const vram = !stale && typeof card.vramUsedMb === "number" && card.vramTotalMb > 0 ? { used: card.vramUsedMb, total: card.vramTotalMb } : null;
  const name = card.label || card.renderNode || "GPU";
  const chip = h("div", { class: "app-tool-gpu", role: "listitem" });
  if (stale) chip.classList.add("is-stale");
  if (!stale && junction !== null) {
    if (junction >= GPU_HOT_C || card.throttling) chip.classList.add("is-hot");
    else if (junction >= GPU_WARM_C) chip.classList.add("is-warm");
  }
  chip.append(h("div", { class: "app-tool-gpu-head" }, h("strong", { class: "ait-ellipsis", text: name }),
    card.role === "llm" ? h("span", { class: "ait-badge ait-badge-info", text: "prompt LLM" }) : null));

  if (numbers) {
    chip.append(h("div", { class: "app-tool-gpu-temp" },
      h("span", { class: "app-tool-gpu-degrees", text: stale || junction === null ? "—" : `${junction}°` }),
      !stale && limit !== null ? h("span", { class: "ait-small ait-faint", text: `/ ${limit}°` }) : null));
    const facts = [];
    if (busy !== null) facts.push(`${busy}% busy`);
    if (vram) facts.push(`${(vram.used / 1024).toFixed(1)} / ${Math.round(vram.total / 1024)} GB`);
    if (facts.length) chip.append(h("div", { class: "ait-small ait-muted", text: facts.join(" · ") }));
  } else {
    // The temperature bar's fill is junction over its limit, with ticks at the warm and hot lines so the zone reads without a number.
    const scale = limit || 110;
    const temp = gpuBar("is-temp", stale || junction === null ? null : junction / scale);
    for (const mark of [GPU_WARM_C, GPU_HOT_C]) {
      const tick = h("i", { class: "app-tool-gpu-tick" });
      tick.style.left = `${Math.min(100, (mark / scale) * 100).toFixed(1)}%`;
      temp.append(tick);
    }
    chip.append(gpuRow("Temp", "Junction temperature", temp),
      gpuRow("Busy", "Busy", gpuBar("", busy === null ? null : busy / 100)),
      gpuRow("VRAM", "VRAM in use", gpuBar("", vram ? vram.used / vram.total : null)));
  }

  let note = null;
  if (stale) note = typeof view.ageSeconds === "number" ? `no reading for ${describeAge(view.ageSeconds)}` : "no reading yet";
  else if (card.throttling) note = "throttling";
  else if (card.perfLevel && card.perfLevel !== "high") note = `clocks down (${card.perfLevel})`;
  if (note) chip.append(h("div", { class: "app-tool-gpu-note", text: note }));

  const title = [`${name} · ${card.renderNode || ""} ${card.pci || ""}`.trim()];
  if (!stale && junction !== null) title.push(`junction ${junction}°${limit !== null ? ` / ${limit}°` : ""}`);
  if (busy !== null) title.push(`${busy}% busy`);
  if (vram) title.push(`${(vram.used / 1024).toFixed(1)} / ${Math.round(vram.total / 1024)} GB VRAM`);
  if (!stale && typeof card.powerW === "number") title.push(`${Math.round(card.powerW)} W`);
  chip.title = title.join("\n");
  return chip;
}

function gpuRow(short, label, bar) {
  return h("div", { class: "app-tool-gpu-row", title: label }, h("span", { class: "app-tool-gpu-key", "aria-label": label, text: short }), bar);
}

// A track with a fill; a null ratio means unknown and leaves the track empty.
function gpuBar(extra, ratio) {
  const fill = h("span", { class: "app-tool-gpu-fill" });
  fill.style.width = ratio === null ? "0%" : `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
  return h("div", { class: `app-tool-gpu-bar ${extra}`.trim() }, fill);
}

// ── job list and results shelf ──────────────────────────────────────────

/** The member's live jobs of one kind, with Cancel and Reuse. */
export function jobList({ onCancel, onReuse }) {
  const hint = h("span", { class: "ait-small ait-muted" });
  const list = h("div", { class: "app-tool-jobs" });
  const el = h("section", { class: "ait-card app-tool-card" },
    h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title", text: "Your jobs" }), hint),
    h("div", { class: "app-tool-card-body" }, list));

  function render(jobs) {
    const staged = jobs.filter((job) => job.status === "staged").length;
    hint.textContent = staged ? `${staged} waiting for a free slot` : "";
    if (!jobs.length) { mount(list, h("div", { class: "ait-small ait-faint", text: "No jobs in flight." })); return; }
    mount(list, jobs.map((job) => h("article", { class: "app-tool-job", dataset: { status: job.status } },
      h("div", { class: "app-tool-job-main" },
        h("p", { class: "app-tool-prompt", text: job.prompt || "No prompt" }),
        h("div", { class: "ait-small ait-muted", text: [statusLabel(job), sizeLabel(job),
          job.refs?.length ? `${job.refs.length} reference${job.refs.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") }),
        job.lastError ? h("div", { class: "ait-small app-tool-error", text: job.lastError }) : null),
      h("div", { class: "app-tool-job-actions" },
        job.status === "staged" ? h("span", { class: "ait-badge ait-badge-warning", text: "Backlog" }) : null,
        LIVE.includes(job.status) ? h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", text: "Cancel", onClick: () => onCancel(job) }) : null,
        h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", title: "Load these settings into the composer", text: "Reuse",
          onClick: () => onReuse(job) })))));
  }

  return { el, render };
}

/** Finished and failed jobs of the last 24 hours. A failure belongs here too: once a job stops being live, this is the only
 *  place that says why. "Mark all seen" marks only the jobs this shelf shows. */
export function resultsShelf({ onOpen }) {
  let shown = [];
  const clear = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", text: "Mark all seen", hidden: true, onClick: markAll });
  const list = h("div", { class: "app-tool-shelf" });
  const el = h("section", { class: "ait-card app-tool-card" },
    h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title", text: "Results" }), clear),
    h("div", { class: "app-tool-card-body" }, list));

  function render(shelf) {
    shown = shelf;
    clear.hidden = !shelf.some((job) => !job.resultSeen);
    if (!shelf.length) { mount(list, h("div", { class: "ait-small ait-faint", text: "Finished renders from the last 24 hours land here." })); return; }
    mount(list, shelf.map((job) => {
      const failed = !job.resultAssetId;
      const thumb = h("span", { class: "app-tool-shelf-thumb" }, h("span", { class: "app-thumb-glyph" }, icon(failed ? "alert" : isImageJob(job) ? "image" : "video")));
      if (job.resultUrl) {
        const img = h("img", { src: isImageJob(job) ? job.resultUrl : `${job.resultUrl}/poster`, alt: "", loading: "lazy", decoding: "async" });
        img.addEventListener("error", () => img.remove(), { once: true });
        thumb.append(img);
      }
      return h("button", { class: `app-tool-shelf-item${failed ? " is-failed" : ""}`, type: "button", title: failed ? job.lastError || "Failed" : job.prompt || "",
        onClick: () => { markSeen(job); onOpen(job); } },
        thumb,
        h("span", { class: "app-tool-shelf-text" },
          h("span", { class: "app-tool-shelf-prompt", text: job.prompt || "Render" }),
          h("span", { class: "app-tool-shelf-flags" },
            job.resultSeen ? null : h("span", { class: "ait-badge ait-badge-accent", text: "New" }),
            failed ? h("span", { class: "ait-badge ait-badge-danger", text: "Failed" })
              : h("span", { class: "ait-small ait-faint", text: isImageJob(job) ? `${job.width}×${job.height}` : formatDuration(job.seconds) }))));
    }));
  }

  function markSeen(job) {
    if (job.resultSeen) return;
    job.resultSeen = true;
    render(shown);
    api.post(`${TOOLS}/seen`, { jobIds: [job.id] }).catch(() => { /* the next poll shows the real state */ });
  }

  function markAll() {
    const ids = shown.filter((job) => !job.resultSeen).map((job) => job.id);
    if (!ids.length) return;
    shown.forEach((job) => { job.resultSeen = true; });
    render(shown);
    api.post(`${TOOLS}/seen`, { jobIds: ids }).catch(reportError);
  }

  return { el, render };
}

/** The opened result: the picture or the clip, the prompt, and the actions the page passes as buttons. */
export function resultPreview() {
  const el = h("section", { class: "ait-card app-tool-card", hidden: true });
  function show(job, ...actions) {
    el.hidden = false;
    const media = isImageJob(job)
      ? h("img", { class: "app-tool-preview-media", src: job.resultUrl, alt: job.prompt || "" })
      : h("video", { class: "app-tool-preview-media", src: job.resultUrl, controls: true, playsinline: true, preload: "metadata", poster: `${job.resultUrl}/poster` });
    const close = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Close", onClick: hide }, icon("close"));
    mount(el,
      h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title ait-ellipsis", text: "Result" }), close),
      h("div", { class: "app-tool-preview" }, media),
      h("div", { class: "app-tool-card-body" },
        h("p", { class: "app-tool-prompt", text: job.prompt || "" }),
        h("div", { class: "ait-small ait-faint", text: [sizeLabel(job), job.seed ? `seed ${job.seed}` : ""].filter(Boolean).join(" · ") }),
        h("div", { class: "app-tool-actions" },
          h("a", { class: "ait-btn ait-btn-sm", href: job.resultUrl, target: "_blank", rel: "noopener" }, icon("external"), "Open"),
          ...actions)));
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function hide() {
    el.querySelectorAll("video").forEach((media) => { media.pause(); media.removeAttribute("src"); media.load(); });
    el.hidden = true;
    el.replaceChildren();
  }
  return { el, show, hide };
}

// ── reference rails ─────────────────────────────────────────────────────

/** One rail of contiguous reference slots: the tools refuse a gap, so removing a slot renumbers the ones after it.
 *  opts: { rail, max(), tag(slot), onTag(tag), onChange() }. picks: [{ id, filename, withAudio, width, height }]. */
export function referenceRail({ rail, label, max, tag, onTag, onChange }) {
  let picks = [];
  const count = h("span", { class: "ait-small ait-faint" });
  const slots = h("div", { class: "app-tool-slots" });
  const el = h("div", { class: "app-tool-rail" }, h("div", { class: "app-tool-rail-head" }, h("span", { class: "ait-label", text: label }), count), slots);

  function render() {
    const limit = max();
    el.hidden = limit <= 0;
    count.textContent = `${picks.length} / ${limit}`;
    mount(slots, picks.map(filled), picks.length < limit
      ? h("button", { class: "app-tool-slot is-empty", type: "button", title: `Add ${rail === "audio" ? "an" : "a"} ${rail} reference`,
        "aria-label": `Add ${rail === "audio" ? "an" : "a"} ${rail} reference`, onClick: () => openPicker(rail, (pick) => { picks.push(pick); render(); onChange?.(); }) },
        icon("plus"))
      : null);
  }

  function filled(pick, slot) {
    const wrap = h("div", { class: "app-tool-slot", title: pick.filename || "" });
    if (rail === "image") wrap.append(h("img", { src: `/media/${pick.id}`, alt: pick.filename || "", loading: "lazy" }));
    else {
      wrap.append(h("span", { class: "app-thumb-glyph" }, icon(rail === "audio" ? "music" : "video")));
      if (rail === "video") {
        const poster = h("img", { src: `/media/${pick.id}/poster`, alt: "", loading: "lazy" });
        poster.addEventListener("error", () => poster.remove(), { once: true });
        wrap.append(poster);
      }
    }
    const name = tag(slot);
    wrap.append(h("button", { class: "app-tool-slot-tag", type: "button", title: "Insert this tag into the prompt", text: name, onClick: () => onTag(name) }));
    if (rail === "video") wrap.append(h("button", { class: `app-tool-slot-audio${pick.withAudio ? " is-on" : ""}`, type: "button", text: "AUD",
      "aria-pressed": String(!!pick.withAudio), title: pick.withAudio ? "Its soundtrack is used" : "Use its soundtrack too",
      onClick: () => { pick.withAudio = !pick.withAudio; render(); } }));
    wrap.append(h("button", { class: "app-tool-slot-remove", type: "button", "aria-label": "Remove reference", title: "Remove",
      onClick: () => { picks.splice(slot, 1); render(); onChange?.(); } }, icon("close")));
    return wrap;
  }

  return {
    el, render,
    get picks() { return picks; },
    set(next) { picks = next; render(); },
    /** Drops the picks past the rail's maximum; answers how many went. */
    trim() { const over = Math.max(0, picks.length - max()); if (over) picks.length -= over; render(); return over; },
    refs() { return picks.map((pick, slot) => ({ rail, slot, assetId: pick.id, withAudio: !!pick.withAudio })); }
  };
}

/** Puts a tag into a textarea at the caret. */
export function insertAtCaret(textarea, text) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  if (typeof start !== "number") textarea.value = value + text;
  else {
    textarea.value = value.slice(0, start) + text + value.slice(end);
    textarea.setSelectionRange(start + text.length, start + text.length);
  }
  textarea.focus();
  textarea.dispatchEvent(new Event("input"));
}

// ── the reference picker ────────────────────────────────────────────────

/** Picks one item of a kind from the member's own media or the shared library; onPick gets { id, filename, width, height }. */
export function openPicker(rail, onPick) {
  let source = "mine";
  const grid = h("div", { class: "app-tool-picker" });
  const tab = (value, text) => h("button", { class: "app-segment", type: "button", text, dataset: { source: value }, onClick: () => { source = value; load(); } });
  const tabs = h("div", { class: "app-segments", role: "group", "aria-label": "Library" }, tab("mine", "My media"), tab("shared", "Shared"));
  const close = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Close" }, icon("close"));
  const dialog = h("dialog", { class: "ait-dialog app-viewer", "aria-label": `Choose ${rail === "audio" ? "an" : "a"} ${rail} reference` },
    h("div", { class: "app-viewer-head" }, h("strong", { class: "ait-grow", text: `Choose ${rail === "audio" ? "an" : "a"} ${rail} reference` }), tabs, close),
    h("div", { class: "app-tool-picker-body" }, grid,
      h("p", { class: "ait-hint", text: "New media goes in through My media; it shows here once uploaded." })));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  load();

  async function load() {
    tabs.querySelectorAll("[data-source]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.source === source)));
    mount(grid, h("div", { class: "app-loading" }, h("div", { class: "ait-spinner" })));
    const wanted = source;
    try {
      const page = await api.get(`/api/v1/library/${source}?kind=${rail}&limit=60`);
      if (wanted !== source || !dialog.open) return;
      if (!page.items.length) {
        mount(grid, empty({ icon: rail === "audio" ? "music" : rail, title: "Nothing here yet",
          text: source === "mine" ? `You have no ${rail} media yet.` : `Nothing ${rail} is shared yet.` }));
        return;
      }
      mount(grid, page.items.map((item) => {
        const thumb = h("span", { class: "app-gen-ref-thumb" }, h("span", { class: "app-thumb-glyph" }, icon(rail === "audio" ? "music" : rail)));
        const src = item.kind === "image" ? item.url : item.posterUrl;
        if (src) {
          const img = h("img", { src, alt: "", loading: "lazy", decoding: "async" });
          img.addEventListener("error", () => img.remove(), { once: true });
          thumb.append(img);
        }
        const meta = item.kind === "image" ? (item.width ? `${item.width}×${item.height}` : "") : formatDuration(item.durationSeconds);
        return h("button", { class: "app-gen-ref app-tool-pick", type: "button", title: item.filename,
          onClick: () => { dialog.close(); onPick({ id: item.id, filename: item.filename, withAudio: false, width: item.width, height: item.height }); } },
          thumb, h("span", { class: "app-gen-ref-name ait-ellipsis", text: item.filename }), meta ? h("span", { class: "ait-small ait-faint", text: meta }) : null);
      }));
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      mount(grid, empty({ icon: "alert", title: "Couldn't load the library", text: err?.message || "Please try again." }));
    }
  }
}

// ── form bits ───────────────────────────────────────────────────────────

export function field(label, control, hint) {
  return h("label", { class: "ait-field" }, h("span", { class: "ait-label", text: label }), control, hint ? h("span", { class: "ait-hint", text: hint }) : null);
}

export function select(options, value) {
  const el = h("select", { class: "ait-select" });
  fillSelect(el, options, value);
  return el;
}

/** options: strings, or { value, label }. */
export function fillSelect(el, options, value) {
  mount(el, (options || []).map((option) => typeof option === "string" ? { value: option, label: option } : option)
    .map((option) => h("option", { value: option.value, text: option.label })));
  if (value !== undefined && [...el.options].some((option) => option.value === String(value))) el.value = String(value);
}

/** A status line under a form: plain or an error. */
export function statusLine() {
  const el = h("p", { class: "ait-small app-tool-status", role: "status" });
  return { el, set(message, isError = false) { el.textContent = message || ""; el.classList.toggle("is-error", !!isError); } };
}

/** "Write the prompt": the prompt specialist turns the idea, and any draft, into the prompt box. Nothing is queued. */
export async function advise({ idea, prompt, button, status, body }) {
  const ideaText = idea.value.trim();
  const draft = prompt.value.trim();
  if (!ideaText && !draft) { status.set("Write your idea first.", true); idea.focus(); return; }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Writing…";
  prompt.classList.add("is-busy");
  status.set(draft ? "Revising your draft…" : "Writing the prompt…");
  try {
    const result = await api.post(`${TOOLS}/prompt/advise`, { idea: ideaText, draft, ...body() });
    prompt.value = result.prompt || "";
    prompt.dispatchEvent(new Event("input"));
    prompt.focus();
    prompt.setSelectionRange(0, 0);
    prompt.scrollTop = 0;
    status.set(result.truncated ? `Prompt written, cut to fit the ${MAX_PROMPT}-character limit. Edit it freely.` : "Prompt written. Edit it freely.");
  } catch (err) {
    if (err?.status === 401) { reportError(err); return; }
    status.set(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
    prompt.classList.remove("is-busy");
  }
}

/** The idea and prompt boxes with the specialist's button and the prompt's counter; Ctrl+Enter in the idea writes the prompt. */
export function promptBoxes({ ideaPlaceholder, promptPlaceholder, onAdvise }) {
  const idea = h("textarea", { class: "ait-textarea app-tool-idea", rows: 2, maxlength: 4000, placeholder: ideaPlaceholder });
  const prompt = h("textarea", { class: "ait-textarea app-tool-prompt-box", rows: 6, maxlength: MAX_PROMPT, placeholder: promptPlaceholder });
  const counter = h("span", { class: "ait-small ait-faint", text: `0 / ${MAX_PROMPT}` });
  const button = h("button", { class: "ait-btn", type: "button", text: "Write the prompt", onClick: () => onAdvise() });
  const status = statusLine();
  prompt.addEventListener("input", () => { counter.textContent = `${prompt.value.length} / ${MAX_PROMPT}`; });
  idea.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onAdvise(); } });
  const el = h("div", { class: "ait-stack-sm" },
    field("Idea", idea, "A sentence or two; the prompt specialist writes the full prompt from it. Ctrl+Enter writes it."),
    h("div", { class: "app-tool-actions" }, button, status.el),
    h("label", { class: "ait-field" }, h("span", { class: "app-tool-rail-head" }, h("span", { class: "ait-label", text: "Prompt" }), counter), prompt));
  return { el, idea, prompt, button, status };
}

// ── page head ───────────────────────────────────────────────────────────

const PAGES = [
  { key: "video", href: "#/tools/video", label: "Video" },
  { key: "image", href: "#/tools/image", label: "Image" },
  { key: "ai", href: "#/tools/ai", label: "AI zone" }
];

/** The tools' page head: the title, a line under it, and the switch between the three member pages. */
export function toolsHead(current, title, text) {
  return h("div", { class: "app-page-head" },
    h("div", { class: "ait-stack-sm" }, h("h1", { text: title }), h("p", { class: "ait-muted", text })),
    h("nav", { class: "app-segments", "aria-label": "Tools" },
      PAGES.map((p) => h("a", { class: "app-segment", href: p.href, "aria-current": p.key === current ? "page" : undefined, text: p.label }))));
}
