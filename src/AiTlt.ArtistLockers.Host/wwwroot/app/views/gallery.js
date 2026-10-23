// The media library: the member's own media or the shared library, filtered by kind and tag, grouped by time (Today,
// Yesterday, This week, This month, the months of this year, then years) and paged per group as it is opened. The member's
// own private media can be uploaded, edited, shared for moderation and deleted here; frames can be saved from any own video.
import { api, ApiError, errorFrom } from "/ai-tlt/ui/v1/api.js";
import { h, mount, icon, avatar, empty, toast, openDialog, confirmDialog } from "/ai-tlt/ui/v1/components.js";
import { formatDateTime, formatDuration, formatSize, reportError, ctx } from "../util.js";
import { modelText, generationSections } from "../generation.js";

const PAGE_SIZE = 60;
const GROUPS_KEY = "artistlockers-groups";
const KINDS = [
  { value: "", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" }
];
const TITLES = {
  mine: { title: "My media", intro: "Everything you uploaded or generated, newest first." },
  shared: { title: "Shared media", intro: "Media the community has published." }
};
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
// The gallery's limits per kind (AssetWriteRules), in MB; checked here too so a large file fails before it is sent.
const UPLOAD_LIMITS = { image: 25, audio: 64, video: 256 };
const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,audio/wav,audio/x-wav,audio/flac,audio/ogg,audio/mpeg,audio/mp4,audio/x-m4a,"
  + "video/mp4,video/webm,.wav,.flac,.ogg,.mp3,.m4a,.mp4,.webm";

export async function render(page, { params, library, isCurrent }) {
  const kind = KINDS.some((k) => k.value && k.value === params.get("kind")) ? params.get("kind") : "";
  const tag = params.get("tag") || "";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const summary = await api.get(`/api/v1/library/${library}/summary?${qs({ tz: timeZone, tag, kind })}`);
  if (!isCurrent()) return;

  const filtered = !!(tag || kind);
  const { title, intro } = TITLES[library];
  page.append(
    h("div", { class: "app-page-head" },
      h("div", { class: "ait-stack-sm" },
        h("h1", { text: title }),
        h("p", { class: "ait-muted", text: `${intro} ${countText(summary.total)}${filtered ? " match" + (summary.total === 1 ? "es" : "") + " the filter" : ""}.` })),
      h("div", { class: "app-head-actions" },
        h("nav", { class: "app-segments", "aria-label": "Kind" },
          KINDS.map((k) => h("a", { class: "app-segment", href: link(library, { tag, kind: k.value }),
            "aria-current": k.value === kind ? "page" : undefined, text: k.label }))),
        library === "mine" ? uploadButton() : null)),
    summary.tags.length || tag ? h("nav", { class: "ait-chips app-tags", "aria-label": "Tags" },
      h("a", { class: "app-chip", href: link(library, { kind }), "aria-current": tag ? undefined : "page", text: "All" }),
      [...new Set([...(tag ? [tag] : []), ...summary.tags])].sort((a, b) => a.localeCompare(b))
        .map((t) => h("a", { class: "app-chip", href: link(library, { tag: t, kind }), "aria-current": t === tag ? "page" : undefined, text: t })))
      : null);

  if (!summary.total) {
    page.append(filtered
      ? empty({ icon: "search", title: "Nothing matches", text: "No media matches this filter." },
        h("a", { class: "ait-btn", href: link(library, {}), text: "Clear filters" }))
      : library === "mine"
        ? empty({ icon: "image", title: "No media yet", text: "Upload images, video or audio, or generate them; they show up here." }, uploadButton())
        : empty({ icon: "users", title: "Nothing shared yet", text: "Published media from the community shows up here." }));
    return;
  }

  const saved = loadGroupState()[library] || {};
  buildGroups(summary.days).forEach((group, index) => {
    const open = saved[group.key] ?? (group.recent || index === 0);
    page.append(groupSection(group, index === 0, open, { library, tag, kind }));
  });
}

function groupSection(group, newest, open, filter) {
  const grid = h("div", { class: "app-media-grid" });
  const foot = h("div", { class: "app-group-foot" });
  const body = h("div", { class: "app-group-body", hidden: !open }, grid, foot);
  const toggle = h("button", { class: "app-group-toggle", type: "button", "aria-expanded": String(open) },
    icon("chevronDown"), h("h2", { class: "app-group-title", text: group.label }),
    h("span", { class: "ait-badge", text: String(group.count) }));
  const state = { loaded: 0, loading: false, started: false, hasMore: true };
  // From is inclusive and To exclusive; the newest group stays open-ended so media added since the summary still shows.
  const from = group.oldest.toISOString();
  const to = newest ? "" : addDays(group.newest, 1).toISOString();

  async function loadMore() {
    if (state.loading || !state.hasMore) return;
    state.loading = true;
    state.started = true;
    mount(foot, h("div", { class: "ait-spinner", role: "status", "aria-label": "Loading" }));
    try {
      const result = await api.get(`/api/v1/library/${filter.library}?${qs({ from, to, tag: filter.tag, kind: filter.kind, limit: PAGE_SIZE, offset: state.loaded })}`);
      grid.append(...result.items.map((item) => card(item, filter.library)));
      state.loaded += result.items.length;
      state.hasMore = result.hasMore && result.items.length > 0;
      const left = Math.max(group.count - state.loaded, 0);
      mount(foot, state.hasMore ? h("button", { class: "ait-btn", type: "button", onClick: loadMore,
        text: left > 0 ? `Load ${Math.min(left, PAGE_SIZE)} more (${left} left)` : "Load more" }) : null);
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      mount(foot, h("button", { class: "ait-btn", type: "button", onClick: loadMore }, icon("refresh"), "Could not load — retry"));
    } finally {
      state.loading = false;
    }
  }

  toggle.addEventListener("click", () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    toggle.setAttribute("aria-expanded", String(nowOpen));
    saveGroupState(filter.library, group.key, nowOpen);
    if (nowOpen && !state.started) loadMore();
  });
  if (open) loadMore();
  return h("section", { class: "app-group" }, toggle, body);
}

function card(item, library) {
  const thumb = h("button", { class: "app-thumb", type: "button", "aria-label": `Open ${item.filename}`, onClick: () => openViewer(item, library) });
  if (item.kind === "image") {
    thumb.append(h("img", { src: item.url, alt: "", loading: "lazy", decoding: "async" }));
  } else {
    thumb.append(h("span", { class: "app-thumb-glyph" }, icon(item.kind === "video" ? "video" : "music")));
    if (item.posterUrl) {
      const poster = h("img", { src: item.posterUrl, alt: "", loading: "lazy", decoding: "async" });
      poster.addEventListener("error", () => poster.remove(), { once: true });
      thumb.append(poster);
    }
    thumb.append(h("span", { class: "app-thumb-play" }, icon("play")));
    const duration = formatDuration(item.durationSeconds);
    if (duration) thumb.append(h("span", { class: "app-thumb-time", text: duration }));
  }
  const flags = [
    library === "mine" && !item.shared ? h("span", { class: "ait-badge", text: "Private" }) : null,
    library === "mine" && item.shared && !item.published ? h("span", { class: "ait-badge ait-badge-warning", text: "In review" }) : null,
    item.kit ? h("span", { class: "ait-badge ait-badge-info", text: "Site Asset" }) : null
  ].filter(Boolean);
  if (flags.length) thumb.append(h("span", { class: "app-thumb-flags" }, flags));

  const meta = [formatSize(item.sizeBytes), item.contentType, item.width && item.height ? `${item.width}×${item.height}` : "",
    item.kind !== "image" ? formatDuration(item.durationSeconds) : ""].filter(Boolean).join(" · ");
  const source = item.sourceFrame === null || item.sourceFrame === undefined ? null
    : item.sourceAssetId
      ? h("div", { class: "ait-small ait-muted" }, "From ",
        h("a", { href: `/media/${item.sourceAssetId}`, target: "_blank", rel: "noopener", text: "a video" }), ` · frame ${item.sourceFrame}`)
      : h("div", { class: "ait-small ait-faint", text: `Frame ${item.sourceFrame} of a deleted video` });
  const owner = library !== "shared" ? null : item.mine
    ? h("div", { class: "app-owner ait-small ait-muted" }, icon("user"), "You")
    : item.owner ? h("div", { class: "app-owner ait-small ait-muted" }, avatar(item.owner.avatarUrl, item.owner.displayName, "xs"),
      h("span", { class: "ait-ellipsis", text: item.owner.displayName })) : null;

  const copy = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Copy link",
    title: item.published ? "Copy link" : "Copy link (only you can open it until it is published)",
    onClick: () => copyLink(item) }, icon("copy"));

  return h("article", { class: "ait-card app-item" },
    thumb,
    h("div", { class: "app-item-body" },
      h("div", { class: "app-item-name ait-ellipsis", title: item.filename, text: item.filename }),
      item.description ? h("p", { class: "app-item-desc", text: item.description }) : null,
      owner,
      source,
      meta ? h("div", { class: "ait-small ait-faint", text: meta }) : null,
      item.tags.length ? h("div", { class: "ait-chips" }, item.tags.map((t) => h("span", { class: "ait-badge", text: t })))
        : h("div", { class: "ait-small ait-faint", text: "no tags" }),
      h("div", { class: "app-item-foot" }, h("span", { class: "ait-small ait-faint", text: formatDateTime(item.createdAt) }), copy)));
}

function openViewer(item, library) {
  let player;
  if (item.kind === "video") {
    player = h("video", { class: "app-viewer-media", src: item.url, controls: true, playsinline: true, preload: "metadata",
      poster: item.posterUrl || undefined });
  } else if (item.kind === "audio") {
    player = h("div", { class: "app-viewer-audio" },
      item.posterUrl ? h("img", { class: "app-viewer-media", src: item.posterUrl, alt: "" }) : h("span", { class: "app-thumb-glyph" }, icon("music")),
      h("audio", { src: item.url, controls: true, preload: "metadata" }));
  } else {
    player = h("img", { class: "app-viewer-media", src: item.url, alt: item.filename });
  }
  const close = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Close" }, icon("close"));
  const dialog = h("dialog", { class: "ait-dialog app-viewer", "aria-label": item.filename },
    h("div", { class: "app-viewer-head" },
      h("strong", { class: "ait-ellipsis ait-grow", text: item.filename }),
      h("a", { class: "ait-btn ait-btn-ghost ait-btn-sm", href: item.url, target: "_blank", rel: "noopener", "aria-label": "Open original" }, icon("external")),
      close),
    h("div", { class: "app-viewer-body" }, player),
    item.description ? h("p", { class: "app-viewer-desc ait-small ait-muted", text: item.description }) : null);
  let changed = false;
  if (library === "mine" && item.mine) dialog.append(ownActions(dialog, item, player, () => { changed = true; }));
  if (library === "mine" && item.kind !== "audio") showGeneration(dialog, item);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    // Stops the download as well as the sound.
    dialog.querySelectorAll("video, audio").forEach((media) => { media.pause(); media.removeAttribute("src"); media.load(); });
    dialog.remove();
    if (changed) refresh();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

// A generated item of the member's own also shows the job that made it; anything else answers 404 and shows nothing more.
async function showGeneration(dialog, item) {
  try {
    const detail = await api.get(`/api/v1/library/mine/${item.id}/generation`);
    if (!dialog.open) return;
    dialog.append(h("div", { class: "app-gen-dialog-body" },
      h("div", { class: "app-gen-head" }, h("h2", { text: "Generation" }), h("span", { class: "ait-badge", text: modelText(detail.job) }),
        h("a", { class: "ait-small", href: `#/generations?kind=${detail.job.kind}`, text: "All generations" })),
      generationSections(detail, item.filename),
      ctx.me.canGenerate && (ctx.me.canGenerateLocal || ['seedance-2-5','seedance-2-0','seedance-2-0-fast','seedance-2-0-mini'].includes(detail.job.model)) ? h("div", {class:"ait-row"},
        h("button", {class:"ait-btn ait-btn-sm",type:"button",text:"Repeat",onClick:()=>handoff(detail,true)}),
        h("button", {class:"ait-btn ait-btn-sm",type:"button",text:"Vary",onClick:()=>handoff(detail,false)})) : null));
  } catch (err) {
    if (err?.status === 401) reportError(err);
    // A 404 is the usual answer (uploads, frames); an unreachable history only costs this section.
  }
}

// Re-renders the current page, which reloads the summary and the open groups.
function refresh() { window.dispatchEvent(new HashChangeEvent("hashchange")); }

// A dialog shows the error it is handed; a 401 reloads to the sign-in screen instead.
function failed(err) {
  if (err instanceof ApiError && err.status === 401) { location.reload(); return new Error("Your session has ended."); }
  return err;
}

function uploadButton() {
  return h("button", { class: "ait-btn ait-btn-primary", type: "button", onClick: uploadMedia }, icon("upload"), "Upload");
}

function uploadMedia() {
  const file = h("input", { class: "ait-input", type: "file", name: "file", accept: UPLOAD_ACCEPT });
  const filename = h("input", { class: "ait-input", type: "text", name: "filename", autocomplete: "off" });
  const description = h("textarea", { class: "ait-textarea", name: "description", maxlength: "4000" });
  const tags = h("input", { class: "ait-input", type: "text", name: "tags", autocomplete: "off", placeholder: "e.g. cover, portrait" });
  const progress = h("progress", { class: "app-progress", max: "100", value: "0", hidden: true });
  file.addEventListener("change", () => { if (file.files[0]) filename.value = file.files[0].name; });
  let request = null;
  let watching = false;
  openDialog({
    title: "Upload media",
    description: "Uploads stay private until you share them.",
    submitLabel: "Upload",
    body: h("div", { class: "ait-stack" },
      field("File", file, `Images up to ${UPLOAD_LIMITS.image} MB, audio up to ${UPLOAD_LIMITS.audio} MB, video up to ${UPLOAD_LIMITS.video} MB.`),
      field("Name", filename),
      field("Description", description),
      field("Tags", tags, "Separate tags with commas."),
      progress),
    onSubmit: async () => {
      const chosen = file.files[0];
      if (!chosen) throw new Error("Choose a file to upload.");
      const kind = chosen.type.split("/")[0];
      if (UPLOAD_LIMITS[kind] && chosen.size > UPLOAD_LIMITS[kind] * 1024 * 1024)
        throw new Error(`That file is too large: ${kind === "image" ? "images" : kind} up to ${UPLOAD_LIMITS[kind]} MB.`);
      const form = new FormData();
      const meta = { filename: filename.value.trim() || chosen.name, description: description.value.trim() || null, tags: splitTags(tags.value) };
      form.append("meta", new Blob([JSON.stringify(meta)], { type: "application/json" }));
      form.append("file", chosen, chosen.name);
      progress.hidden = false;
      progress.value = 0;
      // Cancelling the dialog stops the transfer as well.
      if (!watching) { watching = true; progress.closest("dialog")?.addEventListener("close", () => request?.abort()); }
      try {
        await send(form, (share) => { progress.value = Math.round(share * 100); }, (xhr) => { request = xhr; });
      } catch (err) {
        progress.hidden = true;
        throw failed(err);
      } finally {
        request = null;
      }
    }
  }).then((done) => {
    if (!done) return;
    toast("Uploaded. It is private until you share it.", "success");
    refresh();
  });
}

// fetch cannot report upload progress, so the upload goes through XMLHttpRequest with the same CSRF header as api.js.
function send(form, onProgress, onStart) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/v1/library/mine");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-AiTlt-Request", "1");
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); });
    xhr.addEventListener("load", () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(errorFrom(xhr.status, xhr.response))));
    xhr.addEventListener("error", () => reject(new ApiError(0, "network_error", "The upload did not reach the server. Check your connection and try again.")));
    xhr.addEventListener("abort", () => reject(new ApiError(0, "aborted", "The upload was cancelled.")));
    onStart(xhr);
    xhr.send(form);
  });
}

function field(label, control, hint) {
  return h("label", { class: "ait-field" }, h("span", { class: "ait-label", text: label }), control,
    hint ? h("span", { class: "ait-hint", text: hint }) : null);
}

function splitTags(text) {
  return [...new Set(String(text).split(",").map((tag) => tag.trim()).filter(Boolean))];
}

// The owner's actions under the viewer: edit, share and delete while the media is private (once shared, moderation owns it),
// and the frame tool on any own video.
function ownActions(dialog, item, player, onChange) {
  const status = !item.shared ? "Private: only you can see it."
    : item.published ? "Published in the shared library." : "In review: an admin approves it before it is published.";
  const buttons = h("div", { class: "ait-row" });
  if (!item.shared) {
    buttons.append(
      h("button", { class: "ait-btn ait-btn-sm", type: "button", onClick: () => editMedia(dialog, item, onChange) }, icon("edit"), "Edit"),
      h("button", { class: "ait-btn ait-btn-sm", type: "button", onClick: () => shareMedia(dialog, item, onChange) }, icon("share"), "Share"),
      h("button", { class: "ait-btn ait-btn-sm ait-btn-danger", type: "button", onClick: () => deleteMedia(dialog, item, onChange) }, icon("trash"), "Delete"));
  }
  const section = h("div", { class: "app-viewer-actions" }, h("span", { class: "ait-small ait-muted ait-grow", text: status }), buttons);
  if (item.kind === "video") {
    const frames = h("button", { class: "ait-btn ait-btn-sm", type: "button" }, icon("frame"), "Save a frame");
    frames.addEventListener("click", () => {
      frames.disabled = true;
      section.after(frameTool(item, player, onChange));
    }, { once: true });
    buttons.append(frames);
  }
  return section;
}

async function editMedia(viewer, item, onChange) {
  const filename = h("input", { class: "ait-input", type: "text", name: "filename", value: item.filename, autocomplete: "off" });
  const description = h("textarea", { class: "ait-textarea", name: "description", maxlength: "4000" });
  description.value = item.description || "";
  const tags = h("input", { class: "ait-input", type: "text", name: "tags", value: item.tags.join(", "), autocomplete: "off" });
  const saved = await openDialog({
    title: "Edit media",
    body: h("div", { class: "ait-stack" }, field("Name", filename),
      field("Description", description, "A description can be changed but not removed."), field("Tags", tags, "Separate tags with commas.")),
    onSubmit: async () => {
      try {
        return await api.put(`/api/v1/library/mine/${item.id}`,
          { filename: filename.value.trim() || null, description: description.value.trim() || null, tags: splitTags(tags.value) });
      } catch (err) { throw failed(err); }
    }
  });
  if (!saved) return;
  onChange();
  toast("Saved.", "success");
  viewer.close();
}

async function shareMedia(viewer, item, onChange) {
  const ok = await confirmDialog({ title: "Share with the community?", confirmLabel: "Share", danger: false,
    message: "An admin reviews it before it is published in the shared library. Once shared, you can no longer edit or delete it here." });
  if (!ok) return;
  try {
    await api.post(`/api/v1/library/mine/${item.id}/share`);
    onChange();
    toast("Shared. It is published once an admin approves it.", "success");
    viewer.close();
  } catch (err) { reportError(failed(err)); }
}

async function deleteMedia(viewer, item, onChange) {
  const ok = await confirmDialog({ title: "Delete this media?", confirmLabel: "Delete", message: `${item.filename} is deleted for good.` });
  if (!ok) return;
  try {
    await api.del(`/api/v1/library/mine/${item.id}`);
    onChange();
    toast("Deleted.", "success");
    viewer.close();
  } catch (err) {
    const usages = err instanceof ApiError && err.status === 409 ? err.data?.usages : null;
    if (!usages?.length) { reportError(failed(err)); return; }
    openDialog({ title: "Still in use", description: err.message, hideSubmit: true, cancelLabel: "Close",
      body: h("ul", { class: "app-usages" }, usages.map((use) => h("li", {},
        h("strong", { text: use.area }), h("span", { class: "ait-muted", text: ` · ${use.item} · ${use.field}` })))) });
  }
}

// Picks an exact frame of the video (the player seeks to it) and saves it as a private PNG in the member's own media.
function frameTool(item, video, onChange) {
  const panel = h("div", { class: "app-frame" }, h("div", { class: "ait-row" }, h("div", { class: "ait-spinner", role: "status", "aria-label": "Loading" }),
    h("span", { class: "ait-small ait-muted", text: "Reading the video's frames…" })));
  (async () => {
    let info;
    try {
      info = await api.get(`/api/v1/library/mine/${item.id}/frames`);
    } catch (err) {
      mount(panel, h("div", { class: "ait-banner ait-banner-danger", role: "alert" }, icon("alert"), h("span", { text: failed(err).message })));
      return;
    }
    const last = info.lastFrame;
    const slider = h("input", { class: "app-frame-slider", type: "range", min: "0", max: String(last), step: "1", value: "0", "aria-label": "Frame" });
    const number = h("input", { class: "ait-input app-frame-number", type: "number", min: "0", max: String(last), step: "1", value: "0", "aria-label": "Frame number" });
    const save = h("button", { class: "ait-btn ait-btn-primary ait-btn-sm", type: "button" }, icon("frame"), "Save frame");
    const pick = (frame, seek = true) => {
      const value = Math.min(Math.max(Math.round(Number(frame) || 0), 0), last);
      slider.value = number.value = String(value);
      // Half a frame in, so the player lands inside the frame rather than on its edge.
      if (seek && info.fps > 0) { video.pause(); video.currentTime = Math.min((value + 0.5) / info.fps, info.durationSeconds); }
      return value;
    };
    slider.addEventListener("input", () => pick(slider.value));
    number.addEventListener("change", () => pick(number.value));
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await api.post(`/api/v1/library/mine/${item.id}/frames`, { frame: pick(number.value, false), videoFilename: item.filename });
        onChange();
        toast(result.created ? `Saved ${result.item.filename} to your media.` : `That frame is already saved as ${result.item.filename}.`, "success");
      } catch (err) {
        reportError(failed(err));
      } finally {
        save.disabled = false;
      }
    });
    const extensions = [];
    if(ctx.me.canGenerateLocal){
      const extend = (plus) => h('button',{class:'ait-btn ait-btn-sm',type:'button',text:plus?'Extend+':'Extend',onClick:async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{
          const detail=await api.get(`/api/v1/library/mine/${item.id}/generation`);
          if(plus){const limits=await api.get('/api/v1/tools/limits');if(!(limits.continuationWorkers>0))throw new Error('No render worker is set up for Extend+ right now.');}
          const frame=pick(number.value,false);
          let summary='';try{summary=(await api.post('/api/v1/tools/prompt/summarize',{assetId:item.id})).summary||'';}catch{}
          let options;
          if(plus)options={extendPlus:{frame,sourceAssetId:item.id,filename:item.filename,summary}};
          else{const saved=await api.post(`/api/v1/library/mine/${item.id}/frames`,{frame,videoFilename:item.filename});onChange();options={continueFrom:{asset:{...saved.item,mediaWidth:saved.item.width,mediaHeight:saved.item.height},summary}};}
          handoff(detail,false,options);
        }catch(error){toast(error.status===404?'This video has no generation to extend.':error.message,'error');}finally{button.disabled=false;}
      }});
      extensions.push(extend(false),extend(true));
    }
    pick((video.currentTime || 0) * info.fps, false);
    mount(panel,
      h("div", { class: "ait-row" }, slider, number, h("span", { class: "ait-small ait-muted", text: `of ${last}` })),
      h("div", { class: "ait-row" },
        h("button", { class: "ait-btn ait-btn-sm", type: "button", onClick: () => pick((video.currentTime || 0) * info.fps, false) }, "Current position"),
        h("button", { class: "ait-btn ait-btn-sm", type: "button", onClick: () => pick(last) }, "Last frame"),
        h("span", { class: "ait-grow" }),
        save, ...extensions),
      h("p", { class: "ait-hint", text: `${info.width}×${info.height}, ${Number(info.fps.toFixed(3))} fps. The frame is saved as a private PNG.` }));
  })();
  return panel;
}

async function copyLink(item) {
  try {
    await navigator.clipboard.writeText(new URL(item.url, location.origin).href);
    toast("Link copied.", "success");
  } catch {
    toast("Couldn't copy the link.", "error");
  }
}

function buildGroups(days) {
  const today = startOfDay(new Date());
  const yesterday = addDays(today, -1);
  const weekStart = addDays(today, -((today.getDay() + 6) % 7));
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const groups = [];
  let current = null;
  for (const { day, count } of days) {
    const date = parseDay(day);
    if (!date) continue;
    let key; let label; let recent = true;
    if (date >= today) { key = "today"; label = "Today"; }
    else if (date >= yesterday) { key = "yesterday"; label = "Yesterday"; }
    else if (date >= weekStart) { key = "week"; label = "This week"; }
    else if (date >= monthStart) { key = "month"; label = "This month"; }
    else if (date.getFullYear() === today.getFullYear()) { key = `m-${date.getFullYear()}-${date.getMonth() + 1}`; label = monthFmt.format(date); recent = false; }
    else { key = `y-${date.getFullYear()}`; label = String(date.getFullYear()); recent = false; }
    if (!current || current.key !== key) {
      current = { key, label, recent, count: 0, newest: date, oldest: date };
      groups.push(current);
    }
    current.count += count;
    current.oldest = date;
  }
  return groups;
}

function parseDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function startOfDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
function addDays(date, days) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days); }

function countText(total) { return `${total} item${total === 1 ? "" : "s"}`; }

function link(library, { tag, kind }) {
  const search = qs({ tag, kind });
  return `#/${library === "shared" ? "shared" : "gallery"}${search ? `?${search}` : ""}`;
}

function qs(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
}

function loadGroupState() {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}") || {}; } catch { return {}; }
}

function saveGroupState(library, key, open) {
  try {
    const state = loadGroupState();
    state[library] = { ...(state[library] || {}), [key]: open };
    localStorage.setItem(GROUPS_KEY, JSON.stringify(state));
  } catch { /* the toggle still works for this visit */ }
}

function handoff(detail, keepSeed, extraOptions={}) {
 const kind=detail.job.kind==='image'?'image':'video';const missing=detail.missingRefs||[];
 const job={...detail.job,refs:(detail.job.refs||[]).filter(ref=>!missing.includes(ref.assetId))};
 try{sessionStorage.setItem('artistlockers:gen-handoff',JSON.stringify({kind,job,options:{keepSeed,idea:detail.idea||'',...extraOptions}}));location.href='/tools.html#'+(kind==='image'?'image':'h3');}
 catch(error){toast('This browser could not open the generation in Tools.','error');}
}
