// A generation as its job recorded it: idea, prompt, Extend+ provenance, references, parameters and the exact workflow. Used by
// the Generations page and by the gallery viewer for the member's own generated media. The Gallery hands Repeat/Vary to Tools.
import { h, icon, toast } from "/ai-tlt/ui/v1/components.js";
import { formatDateTime, formatDuration } from "./util.js";

export const STATUSES = [
  { value: "completed", label: "Completed", badge: "ait-badge-success" },
  { value: "failed", label: "Failed", badge: "ait-badge-danger" },
  { value: "cancelled", label: "Cancelled", badge: "" },
  { value: "running", label: "Running", badge: "ait-badge-info" },
  { value: "queued", label: "Queued", badge: "ait-badge-warning" },
  { value: "staged", label: "Staged", badge: "ait-badge-warning" }
];

export function statusBadge(status) {
  const known = STATUSES.find((s) => s.value === status);
  return h("span", { class: `ait-badge ${known?.badge || ""}`.trim(), text: known?.label || status });
}

/** "MiniMax H3", or "Qwen-Image 2.1 · edit" for an image job with a mode. */
export function modelText(job) {
  return job.modelLabel + (job.kind === "image" && job.mode ? ` · ${job.mode}` : "");
}

/** The result as a player: a video, an image, or nothing when the job produced none. */
export function resultPlayer(job) {
  if (!job.resultUrl) return null;
  return job.kind === "video"
    ? h("video", { class: "app-viewer-media", src: job.resultUrl, controls: true, playsinline: true, preload: "metadata", poster: `${job.resultUrl}/poster` })
    : h("img", { class: "app-viewer-media", src: job.resultUrl, alt: "" });
}

/** Everything the job recorded, as sections; filename names the downloaded workflow. */
export function generationSections(detail, filename) {
  const { job } = detail;
  const body = h("div", { class: "app-gen" });
  if (job.lastError) body.append(h("div", { class: "ait-banner ait-banner-danger app-gen-error", role: "note" }, icon("alert"),
    h("span", { text: job.lastError })));
  if (job.idea) body.append(textBlock("Idea", job.idea));
  body.append(textBlock("Prompt", job.prompt || ""));
  if (job.negativePrompt) body.append(textBlock("Negative prompt", job.negativePrompt));
  if (detail.continuation) body.append(textBlock("Extend+", describeExtendPlus(detail.continuation)));

  const refs = [...job.refs].sort((a, b) => a.rail === b.rail ? a.slot - b.slot : a.rail.localeCompare(b.rail));
  if (refs.length) body.append(section(`References (${refs.length})`, null, h("div", { class: "app-gen-refs" }, refs.map(refTile))));
  body.append(section("Parameters", null, params(job)));
  if (detail.workflow) body.append(workflowBlock(detail.workflow, filename));
  return body;
}

// The same wording as Mobvision's gallery.
function describeExtendPlus(c) {
  return `Continues ${c.sourceFilename || "a clip"} from frame ${c.frame}: ${c.contextFrames} frames leading up to it guided the start`
    + `${c.withAudio ? ", picture and sound" : " (the clip has no sound)"}, and the take keeps the ${c.deliveredFrames} new frames after them.`;
}

function section(label, copyText, ...content) {
  return h("section", { class: "app-gen-section" },
    h("div", { class: "app-gen-label" }, h("span", { text: label }),
      copyText ? h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", onClick: () => copy(copyText, label) },
        icon("copy"), "Copy") : null),
    ...content);
}

function textBlock(label, text) {
  return section(label, text, h("p", { class: "app-gen-text", text }));
}

function refTile(ref) {
  const caption = `${ref.rail} ${ref.slot + 1}${ref.withAudio ? " · with audio" : ""}`;
  const thumb = h("span", { class: "app-gen-ref-thumb" });
  // A reference deleted since the job ran no longer loads; the tile says so instead of showing a broken image.
  const gone = () => { thumb.replaceChildren(h("span", { class: "ait-small ait-faint", text: "deleted" })); tile.removeAttribute("href"); };
  if (ref.rail === "image") {
    const img = h("img", { src: ref.url, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", gone, { once: true });
    thumb.append(img);
  } else {
    thumb.append(h("span", { class: "app-thumb-glyph" }, icon(ref.rail === "audio" ? "music" : "video")));
    if (ref.rail === "video") {
      const poster = h("img", { src: `${ref.url}/poster`, alt: "", loading: "lazy", decoding: "async" });
      poster.addEventListener("error", () => poster.remove(), { once: true });
      thumb.append(poster);
    }
  }
  const tile = h("a", { class: "app-gen-ref", href: ref.url, target: "_blank", rel: "noopener",
    title: caption + (ref.filename ? ` · ${ref.filename}` : "") },
    thumb, h("span", { class: "app-gen-ref-name ait-ellipsis", text: ref.filename || caption }),
    h("span", { class: "ait-small ait-faint", text: caption }));
  return tile;
}

function params(job) {
  const rows = [["Model", job.modelLabel], ["Mode", job.mode], ["Size", `${job.width} × ${job.height}`]];
  if (job.kind === "video") {
    rows.push(["Length", `${job.lengthFrames} frames · ${formatDuration(job.seconds) || `${job.seconds} s`}`]);
    rows.push(["Flow", job.flow + (job.runFlow && job.runFlow !== job.flow ? ` → ${job.runFlow}` : "")]);
    rows.push(["Ref image size", job.refImageSize]);
  }
  rows.push(["Seed", job.seed], ["Steps", String(job.steps)], ["Sampler", job.sampler], ["Scheduler", job.scheduler]);
  if (job.cfg !== null && job.cfg !== undefined) rows.push(["CFG", String(job.cfg)]);
  if (job.refResolution !== null && job.refResolution !== undefined) rows.push(["Ref resolution", String(job.refResolution)]);
  if (job.attemptCount > 1) rows.push(["Attempts", String(job.attemptCount)]);
  rows.push(["Created", formatDateTime(job.createdAt)]);
  if (job.completedAt) rows.push([job.status === "completed" ? "Completed" : "Ended", formatDateTime(job.completedAt)]);
  if (job.startedAt && job.completedAt) {
    const seconds = Math.round((new Date(job.completedAt) - new Date(job.startedAt)) / 1000);
    if (seconds >= 0) rows.push(["Render time", formatDuration(seconds)]);
  }
  return h("dl", { class: "ait-dl app-gen-params" }, rows.filter(([, value]) => value !== null && value !== undefined && value !== "")
    .flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { class: label === "Seed" ? "ait-mono" : undefined, text: value })]));
}

// The server sends the workflow as indented text: parsed here, its 64-bit seeds would be rounded. Copy and download keep it exact.
function workflowBlock(text, filename) {
  let nodes = 0;
  try { nodes = Object.keys(JSON.parse(text) || {}).length; } catch { /* the count is only a hint */ }
  const download = () => {
    const link = h("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })),
      download: `${String(filename || "generation").replace(/\.[^.]+$/, "")}-workflow.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return h("details", { class: "app-gen-workflow" },
    h("summary", { text: `Workflow (${nodes ? `${nodes} nodes, ` : ""}as sent)` }),
    h("div", { class: "app-gen-label" },
      h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", onClick: () => copy(text, "Workflow") }, icon("copy"), "Copy"),
      h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", onClick: download }, icon("external"), "Download .json")),
    h("pre", { class: "app-gen-pre", text }));
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied.`, "success");
  } catch {
    toast("Couldn't copy.", "error");
  }
}
