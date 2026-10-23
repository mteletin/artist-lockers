// The member's generation history, newest first: every job they sent to the video and image generators, with its prompt,
// settings and result. Filtered by kind and status; a card opens the job's full detail.
import { api } from "/ai-tlt/ui/v1/api.js";
import { h, mount, icon, empty } from "/ai-tlt/ui/v1/components.js";
import { ctx, formatDateTime, formatDuration, reportError } from "../util.js";
import { STATUSES, statusBadge, modelText, resultPlayer, generationSections } from "../generation.js";

const PAGE_SIZE = 60;
const KINDS = [
  { value: "", label: "All" },
  { value: "video", label: "Videos" },
  { value: "image", label: "Images" }
];

export async function render(page, { params, isCurrent }) {
  const kind = KINDS.some((k) => k.value && k.value === params.get("kind")) ? params.get("kind") : "";
  const status = STATUSES.some((s) => s.value === params.get("status")) ? params.get("status") : "";
  const first = await api.get(`/api/v1/generations?${qs({ kind, status, limit: PAGE_SIZE })}`);
  if (!isCurrent()) return;

  const canGenerate = !!ctx.me?.canGenerate;
  page.append(
    h("div", { class: "app-page-head" },
      h("div", { class: "ait-stack-sm" },
        h("h1", { text: "Generations" }),
        h("p", { class: "ait-muted" }, "Everything you asked the generators for, newest first: prompt, settings and result.",
          canGenerate ? [" New ones start in ", h("a", { href: "#/tools/video", text: "Video Generation" }), " and the ",
            h("a", { href: "#/tools/image", text: "Image Generator" }), "."] : null)),
      h("nav", { class: "app-segments", "aria-label": "Kind" },
        KINDS.map((k) => h("a", { class: "app-segment", href: link({ kind: k.value, status }),
          "aria-current": k.value === kind ? "page" : undefined, text: k.label })))),
    h("nav", { class: "ait-chips app-tags", "aria-label": "Status" },
      h("a", { class: "app-chip", href: link({ kind }), "aria-current": status ? undefined : "page", text: "Any status" }),
      STATUSES.map((s) => h("a", { class: "app-chip", href: link({ kind, status: s.value }),
        "aria-current": s.value === status ? "page" : undefined, text: s.label }))));

  if (!first.items.length) {
    page.append(kind || status
      ? empty({ icon: "search", title: "Nothing matches", text: "No generation matches this filter." },
        h("a", { class: "ait-btn", href: link({}), text: "Clear filters" }))
      : empty({ icon: "video", title: "No generations yet", text: "Videos and images you generate in Tools show up here." },
        canGenerate ? h("a", { class: "ait-btn", href: "#/tools/video", text: "Open Tools" }) : null));
    return;
  }

  const grid = h("div", { class: "app-media-grid" });
  const foot = h("div", { class: "app-group-foot" });
  let loaded = 0;
  let loading = false;
  const show = (result) => {
    grid.append(...result.items.map(card));
    loaded += result.items.length;
    mount(foot, result.hasMore && result.items.length ? h("button", { class: "ait-btn", type: "button", onClick: more, text: "Load more" }) : null);
  };
  async function more() {
    if (loading) return;
    loading = true;
    mount(foot, h("div", { class: "ait-spinner", role: "status", "aria-label": "Loading" }));
    try {
      show(await api.get(`/api/v1/generations?${qs({ kind, status, limit: PAGE_SIZE, offset: loaded })}`));
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      mount(foot, h("button", { class: "ait-btn", type: "button", onClick: more }, icon("refresh"), "Could not load — retry"));
    } finally {
      loading = false;
    }
  }
  show(first);
  page.append(grid, foot);
}

function card(job) {
  const thumb = h("button", { class: "app-thumb", type: "button", "aria-label": `Open ${modelText(job)} generation`, onClick: () => openJob(job) });
  thumb.append(h("span", { class: "app-thumb-glyph" }, icon(job.status === "failed" ? "alert" : job.kind === "image" ? "image" : "video")));
  if (job.resultUrl) {
    const src = job.kind === "video" ? `${job.resultUrl}/poster` : job.resultUrl;
    const img = h("img", { src, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.remove(), { once: true });
    thumb.append(img);
    if (job.kind === "video") thumb.append(h("span", { class: "app-thumb-play" }, icon("play")));
  }
  if (job.kind === "video" && job.seconds > 0) thumb.append(h("span", { class: "app-thumb-time", text: formatDuration(job.seconds) }));
  thumb.append(h("span", { class: "app-thumb-flags" }, statusBadge(job.status)));

  return h("article", { class: "ait-card app-item" },
    thumb,
    h("div", { class: "app-item-body" },
      h("div", { class: "app-item-name ait-ellipsis", text: modelText(job) }),
      h("p", { class: "app-item-desc app-gen-prompt", title: job.prompt, text: job.prompt || "No prompt" }),
      h("div", { class: "ait-small ait-faint", text: `${job.width}×${job.height}${job.refs.length ? ` · ${job.refs.length} ref${job.refs.length === 1 ? "" : "s"}` : ""}` }),
      h("div", { class: "app-item-foot" }, h("span", { class: "ait-small ait-faint", text: formatDateTime(job.createdAt) }))));
}

async function openJob(job) {
  const body = h("div", { class: "app-gen-dialog-body" }, h("div", { class: "app-loading" }, h("div", { class: "ait-spinner" })));
  const close = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Close" }, icon("close"));
  const player = resultPlayer(job);
  const dialog = h("dialog", { class: "ait-dialog app-viewer", "aria-label": `${modelText(job)} generation` },
    h("div", { class: "app-viewer-head" },
      h("strong", { class: "ait-ellipsis ait-grow", text: modelText(job) }),
      statusBadge(job.status),
      job.resultUrl ? h("a", { class: "ait-btn ait-btn-ghost ait-btn-sm", href: job.resultUrl, target: "_blank", rel: "noopener", "aria-label": "Open result" }, icon("external")) : null,
      close),
    player ? h("div", { class: "app-viewer-body" }, player) : null,
    body);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    dialog.querySelectorAll("video").forEach((media) => { media.pause(); media.removeAttribute("src"); media.load(); });
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  try {
    const detail = await api.get(`/api/v1/generations/${job.id}`);
    if (dialog.open) mount(body, generationSections(detail, `${job.model}-${job.id.slice(0, 8)}`));
  } catch (err) {
    if (!dialog.open) return;
    if (err?.status === 401) { reportError(err); return; }
    mount(body, empty({ icon: "alert", title: "Couldn't load this generation", text: err?.message || "Please try again." }));
  }
}

function link({ kind, status }) {
  const search = qs({ kind, status });
  return `#/generations${search ? `?${search}` : ""}`;
}

function qs(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}
