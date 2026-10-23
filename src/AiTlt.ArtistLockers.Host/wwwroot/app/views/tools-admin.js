// Operate: the generation tools' operator page. The render instances, the Video Generation caps and model files, the
// generation models, the GPUs and the job audit across every member. The studio checks the operator roles before it
// calls the tools with the operate scope; this page is only reached by the people it was offered to. Ported from
// Mobvision's admin-h3.js and admin-audit.js.
import { api } from "/ai-tlt/ui/v1/api.js";
import { h, mount, icon, empty, confirmDialog } from "/ai-tlt/ui/v1/components.js";
import { formatDateTime, reportError } from "../util.js";
import { TOOLS, gpuBoard, field, select, fillSelect, statusLine } from "../tools.js";

const OPERATE = `${TOOLS}/operate`;
const GB = 1024 ** 3;
const GPU_POLL_MS = 15000;
const STATUSES = ["staged", "queued", "running", "completed", "failed", "cancelled"];

const VIEWS = [
  { key: "setup", href: "#/tools/admin", label: "Instances & settings" },
  { key: "audit", href: "#/tools/admin?view=audit", label: "Job audit" }
];

export async function render(page, { params, isCurrent }) {
  const view = params.get("view") === "audit" ? "audit" : "setup";
  const head = h("div", { class: "app-page-head" },
    h("div", { class: "ait-stack-sm" }, h("h1", { text: "Operate" }),
      h("p", { class: "ait-muted", text: "The render instances, the generation settings and every member's jobs." })),
    h("nav", { class: "app-segments", "aria-label": "Operate" },
      VIEWS.map((v) => h("a", { class: "app-segment", href: v.href, "aria-current": v.key === view ? "page" : undefined, text: v.label }))));
  if (view === "audit") await renderAudit(page, head, isCurrent);
  else await renderSetup(page, head, isCurrent);
}

// ── instances, settings and models ──────────────────────────────────────

// Image-model settings, in the order the form shows them. `span` fields take the full row.
const IMAGE_FIELDS = [
  { key: "unetName", label: "Diffusion model", type: "text", span: true },
  { key: "clipName", label: "Text encoder", type: "text", span: true },
  { key: "vaeName", label: "VAE", type: "text", span: true },
  { key: "steps", label: "Steps", type: "number", min: 1, max: 60, step: 1 },
  { key: "cfg", label: "CFG without references", type: "number", min: 1, max: 10, step: 0.1 },
  { key: "refCfg", label: "CFG with references", type: "number", min: 1, max: 10, step: 0.1 },
  { key: "sampler", label: "Sampler", type: "select", values: (data) => data.samplers },
  { key: "scheduler", label: "Scheduler", type: "select", values: (data) => data.schedulers },
  { key: "refResolution", label: "Reference resolution", type: "select", values: () => ["1024", "2048"], number: true },
  { key: "maxRefs", label: "Max references", type: "number", min: 1, max: 10, step: 1 },
  { key: "negativePrompt", label: "Negative prompt", type: "text", span: true }
];

function input(type, value, extra = {}) {
  return h("input", { class: "ait-input", type, value: value == null ? "" : String(value), ...extra });
}

async function renderSetup(page, head, isCurrent) {
  let data = await api.get(`${OPERATE}/settings`);
  if (!isCurrent()) return;
  const status = statusLine();
  const gpus = gpuBoard();
  const workers = h("div", { class: "app-tool-jobs" });
  const models = h("div", { class: "ait-stack" });

  // ── the settings form: built once, filled from every read ──
  const s = {
    inFlight: input("number", "", { min: "1", max: "16", step: "1" }),
    maxFrames: input("number", "", { min: "5", step: "17" }),
    maxPixels: input("number", "", { min: "65536", step: "1024" }),
    quotaGb: input("number", "", { min: "0.1", step: "0.1" }),
    width: input("number", "", { min: "256", max: "2048", step: "32" }),
    height: input("number", "", { min: "256", max: "2048", step: "32" }),
    length: input("number", "", { min: "5", step: "17" }),
    steps: input("number", "", { min: "1", max: "60", step: "1" }),
    sampler: select([]),
    scheduler: select([]),
    fps: input("number", "", { min: "1", max: "60", step: "1" }),
    allowMax: h("input", { type: "checkbox" }),
    unet: input("text", ""),
    fusedUnet: input("text", ""),
    fusedSampler: select([]),
    fusedScheduler: select([]),
    fusedSteps: input("number", "", { min: "1", max: "60", step: "1" }),
    lora: input("text", ""),
    loraStrength: input("number", "", { min: "0", max: "2", step: "0.05" }),
    clip: input("text", ""),
    videoVae: input("text", ""),
    audioVae: input("text", "")
  };
  const span = (label, control) => h("div", { class: "ait-span-2" }, field(label, control));
  const saveSettings = h("button", { class: "ait-btn ait-btn-primary", type: "submit", text: "Save settings" });
  const settingsForm = h("form", { class: "ait-form-grid", novalidate: true },
    field("Max in-flight per member", s.inFlight), field("Max frames", s.maxFrames),
    field("Max pixels", s.maxPixels), field("Storage per member (GB)", s.quotaGb),
    field("Default width", s.width), field("Default height", s.height),
    field("Default length (frames)", s.length), field("Default steps", s.steps),
    field("Default sampler", s.sampler), field("Default scheduler", s.scheduler),
    field("Output FPS", s.fps),
    h("label", { class: "ait-check" }, s.allowMax, h("span", { text: "Allow reference size “max” (several times slower)" })),
    h("h3", { class: "ait-span-2 app-tool-title", text: "Model files" }),
    span("Diffusion model (default for instances without their own)", s.unet),
    span("Fused diffusion model (jobs that ask for the fused flow)", s.fusedUnet),
    field("Fused sampler", s.fusedSampler), field("Fused scheduler", s.fusedScheduler),
    field("Fused steps", s.fusedSteps), field("LoRA strength", s.loraStrength),
    span("LoRA", s.lora), span("CLIP / text encoder", s.clip), span("Video VAE", s.videoVae), span("Audio VAE", s.audioVae),
    h("div", { class: "ait-span-2 app-tool-actions" }, saveSettings));

  function fill() {
    const v = data.settings;
    s.inFlight.value = v.maxInFlightPerUser;
    s.maxFrames.value = v.maxFrames;
    s.maxPixels.value = v.maxPixels;
    s.quotaGb.value = (v.quotaBytesPerUser / GB).toFixed(1);
    s.width.value = v.defaultWidth;
    s.height.value = v.defaultHeight;
    s.length.value = v.defaultLength;
    s.steps.value = v.defaultSteps;
    fillSelect(s.sampler, data.samplers, v.defaultSampler);
    fillSelect(s.scheduler, data.schedulers, v.defaultScheduler);
    s.fps.value = v.fps;
    s.allowMax.checked = !!v.allowRefImageSizeMax;
    s.unet.value = v.unetName || "";
    s.fusedUnet.value = v.fusedUnetName || "";
    fillSelect(s.fusedSampler, data.samplers, v.fusedSampler);
    fillSelect(s.fusedScheduler, data.schedulers, v.fusedScheduler);
    s.fusedSteps.value = v.fusedSteps;
    s.lora.value = v.loraName || "";
    s.loraStrength.value = v.loraStrength;
    s.clip.value = v.clipName || "";
    s.videoVae.value = v.videoVaeName || "";
    s.audioVae.value = v.audioVaeName || "";
    renderWorkers();
    renderModels();
  }

  async function reload() {
    data = await api.get(`${OPERATE}/settings`);
    if (isCurrent()) fill();
  }

  // Every change is followed by a fresh read: the tools snap frames and dimensions onto the legal grid, clamp steps, cfg and
  // reference counts, and keep unsafe filenames out, so only a read shows what is in force.
  async function act(pending, call, done) {
    status.set(pending);
    try {
      await call();
      await reload();
      status.set(done);
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      status.set(err.message, true);
    }
  }

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = (control) => control.value.trim();
    const body = {
      maxInFlightPerUser: Number(s.inFlight.value), maxFrames: Number(s.maxFrames.value), maxPixels: Number(s.maxPixels.value),
      quotaBytesPerUser: Math.round(Number(s.quotaGb.value) * GB), allowRefImageSizeMax: s.allowMax.checked,
      defaultSampler: s.sampler.value, defaultScheduler: s.scheduler.value, defaultSteps: Number(s.steps.value),
      defaultWidth: Number(s.width.value), defaultHeight: Number(s.height.value), defaultLength: Number(s.length.value),
      unetName: text(s.unet), fusedUnetName: text(s.fusedUnet), fusedSampler: s.fusedSampler.value, fusedScheduler: s.fusedScheduler.value,
      fusedSteps: Number(s.fusedSteps.value), loraName: text(s.lora), loraStrength: Number(s.loraStrength.value), clipName: text(s.clip),
      videoVaeName: text(s.videoVae), audioVaeName: text(s.audioVae), fps: Number(s.fps.value)
    };
    saveSettings.disabled = true;
    try { await act("Saving…", () => api.put(`${OPERATE}/settings`, body), "Settings saved."); } finally { saveSettings.disabled = false; }
  });

  // ── render instances ──
  function renderWorkers() {
    const list = data.workers || [];
    if (!list.length) { mount(workers, h("div", { class: "ait-small ait-faint", text: "No instances registered." })); return; }
    mount(workers, list.map((worker) => {
      const base = { label: worker.label, baseUrl: worker.baseUrl, enabled: worker.enabled, sortOrder: worker.sortOrder };
      const save = (change, done) => act("Updating the instance…", () => api.put(`${OPERATE}/workers/${worker.id}`, { ...base, ...change }), done);
      // The graph follows the model: a name containing "fused" renders without the LoRA, in a few steps.
      const model = input("text", worker.unetName || "", { placeholder: `Default: ${data.settings.unetName || "the diffusion model in the settings"}`,
        "aria-label": `${worker.label} diffusion model` });
      return h("article", { class: "app-tool-job" },
        h("div", { class: "app-tool-job-main ait-stack-sm" },
          h("div", { class: "ait-row" }, h("strong", { text: worker.label }),
            worker.busy ? h("span", { class: "ait-badge ait-badge-accent", text: "Rendering" }) : null,
            worker.enabled ? null : h("span", { class: "ait-badge", text: "Disabled" })),
          h("span", { class: "ait-small ait-faint ait-mono", text: worker.baseUrl }),
          worker.lastError ? h("span", { class: "ait-small app-tool-error", text: `Last error: ${worker.lastError}` })
            : h("span", { class: "ait-small ait-muted", text: `Last seen ${worker.lastSeenAt ? formatDateTime(worker.lastSeenAt) : "never"}` }),
          h("div", { class: "app-tool-actions" }, model,
            // An empty name clears the override back to the default model.
            h("button", { class: "ait-btn ait-btn-sm", type: "button", text: "Save model",
              onClick: () => save({ unetName: model.value.trim() }, "Instance model saved.") }))),
        h("div", { class: "app-tool-job-actions" },
          h("button", { class: "ait-btn ait-btn-sm", type: "button", text: worker.enabled ? "Disable" : "Enable",
            onClick: () => save({ enabled: !worker.enabled }, worker.enabled ? `${worker.label} disabled.` : `${worker.label} enabled.`) }),
          // Extend+ jobs only go to instances switched on here.
          h("button", { class: "ait-btn ait-btn-sm", type: "button", text: worker.canContinue ? "Extend+ on" : "Extend+ off",
            "aria-pressed": String(!!worker.canContinue),
            title: worker.canContinue ? "This instance takes Extend+ renders. Click to stop sending it any."
              : "Let this instance take Extend+ renders (it needs the memory for the guide).",
            onClick: () => save({ canContinue: !worker.canContinue }, "Instance updated.") }),
          h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", onClick: () => removeWorker(worker) }, icon("trash"), "Remove")));
    }));
  }

  async function removeWorker(worker) {
    const ok = await confirmDialog({ title: `Remove ${worker.label}?`,
      message: "Anything running on it is released back to the queue and picked up elsewhere.", confirmLabel: "Remove" });
    if (ok) await act("Removing the instance…", () => api.del(`${OPERATE}/workers/${worker.id}`), "Instance removed.");
  }

  const newLabel = input("text", "", { maxlength: "60", placeholder: "Label, e.g. GPU 3", "aria-label": "Instance label" });
  const newUrl = input("url", "", { placeholder: "http://host:port", "aria-label": "Instance base URL" });
  const addForm = h("form", { class: "app-tool-actions", novalidate: true }, newLabel, newUrl,
    h("button", { class: "ait-btn", type: "submit" }, icon("plus"), "Add instance"));
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const label = newLabel.value.trim();
    const baseUrl = newUrl.value.trim();
    if (!label || !baseUrl) { status.set("Give the instance a label and a base URL.", true); return; }
    await act("Adding the instance…", async () => {
      await api.post(`${OPERATE}/workers`, { label, baseUrl, enabled: true, sortOrder: (data.workers || []).length + 1 });
      newLabel.value = "";
      newUrl.value = "";
    }, "Instance added.");
  });

  const probe = h("button", { class: "ait-btn", type: "button", onClick: async () => {
    probe.disabled = true;
    status.set("Probing the instances…");
    try {
      const results = await api.post(`${OPERATE}/workers/probe`);
      const up = results.filter((result) => result.reachable).length;
      await reload();
      status.set(results.length ? `${up} of ${results.length} instance(s) reachable.` : "No instances registered.");
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      status.set(err.message, true);
    } finally {
      probe.disabled = false;
    }
  } }, icon("refresh"), "Probe instances");

  // ── generation models ──
  function renderModels() {
    const list = data.models || [];
    if (!list.length) { mount(models, h("div", { class: "ait-small ait-faint", text: "No generation models registered." })); return; }
    mount(models, list.map(modelForm));
  }

  function modelForm(model) {
    const label = input("text", model.label, { maxlength: "100" });
    const controls = {};
    const fields = (model.image ? IMAGE_FIELDS : []).map((spec) => {
      const value = model.image[spec.key];
      const control = spec.type === "select" ? select(spec.values(data), value == null ? "" : String(value))
        : input(spec.type, value, { min: spec.min == null ? undefined : String(spec.min), max: spec.max == null ? undefined : String(spec.max),
          step: spec.step == null ? undefined : String(spec.step) });
      controls[spec.key] = control;
      return spec.span ? span(spec.label, control) : field(spec.label, control);
    });
    const form = h("form", { class: "ait-card app-tool-card", novalidate: true },
      h("div", { class: "app-tool-card-head" },
        h("div", { class: "ait-stack-sm" }, h("strong", { text: model.label }),
          h("span", { class: "ait-small ait-faint", text: `${model.id} · ${model.kind === "image" ? "Image Generator" : "Video Generation"}` })),
        h("div", { class: "ait-row" },
          h("span", { class: `ait-badge ${model.enabled ? "ait-badge-success" : ""}`.trim(), text: model.enabled ? "Enabled" : "Disabled" }),
          h("button", { class: "ait-btn ait-btn-sm", type: "button", text: model.enabled ? "Disable" : "Enable",
            onClick: () => act("Saving the model…", () => api.put(`${OPERATE}/models/${encodeURIComponent(model.id)}`, { enabled: !model.enabled }), "Model saved.") }))),
      h("div", { class: "app-tool-card-body" },
        h("div", { class: "ait-form-grid" }, span("Label", label), fields,
          h("div", { class: "ait-span-2 app-tool-actions" }, h("button", { class: "ait-btn", type: "submit", text: `Save ${model.label}` })))));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const body = { label: label.value.trim() };
      if (model.image) {
        body.image = {};
        for (const spec of IMAGE_FIELDS) {
          const value = controls[spec.key].value;
          body.image[spec.key] = spec.type === "number" || spec.number ? Number(value) : value.trim();
        }
      }
      act("Saving the model…", () => api.put(`${OPERATE}/models/${encodeURIComponent(model.id)}`, body), "Model saved.");
    });
    return form;
  }

  // ── the GPUs: read on their own clock while the page is open ──
  async function pollGpus() {
    if (!isCurrent()) return;
    try {
      const view = await api.get(`${OPERATE}/gpus`);
      if (isCurrent()) gpus.render(view);
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
    }
    if (isCurrent()) setTimeout(pollGpus, GPU_POLL_MS);
  }

  const section = (title, hint, ...body) => h("section", { class: "ait-card app-tool-card" },
    h("div", { class: "app-tool-card-head" }, h("h2", { class: "app-tool-title", text: title })),
    h("div", { class: "app-tool-card-body ait-stack" }, hint ? h("p", { class: "ait-hint", text: hint }) : null, ...body));

  fill();
  page.append(head,
    h("div", { class: "app-tool-actions" }, probe, status.el),
    h("div", { class: "ait-stack" },
      gpus.el,
      section("Render instances", "One ComfyUI instance per GPU, shared by Video Generation and the Image Generator. The dispatcher keeps each instance's own queue empty and hands it one prompt at a time, so a disabled instance drains rather than stalls.",
        workers, addForm),
      section("Video Generation", "Frame counts snap to 5 + 17k and dimensions to a 32-pixel grid, so what you type here is rounded to the nearest legal value on save.",
        settingsForm),
      section("Generation models", "One entry per model the tools offer. A disabled model leaves its page's model menu and refuses new jobs; queued jobs still run. The in-flight cap above is shared by every model.",
        models)));
  pollGpus();
}

// ── the job audit ───────────────────────────────────────────────────────

async function renderAudit(page, head, isCurrent) {
  let pageNumber = 1;
  let pageSize = 100;
  let total = 0;
  let requestId = 0;
  let filters = new URLSearchParams();
  const status = statusLine();
  const list = h("div", { class: "app-tool-audit" });

  const search = input("search", "", { maxlength: "200", placeholder: "Name, prompt, job or member id" });
  const state = select([{ value: "", label: "All statuses" }, ...STATUSES], "");
  const model = input("text", "", { maxlength: "100", placeholder: "All models" });
  const from = input("date", "");
  const to = input("date", "");
  const filterForm = h("form", { class: "ait-card app-tool-card", novalidate: true },
    h("div", { class: "app-tool-card-body ait-stack" },
      h("div", { class: "ait-form-grid" },
        h("div", { class: "ait-span-2" }, field("Search member, prompt or id", search)),
        field("Status", state), field("Model", model), field("Created from", from), field("Created through", to)),
      h("div", { class: "app-tool-actions" },
        h("button", { class: "ait-btn ait-btn-primary", type: "submit", text: "Apply filters" }),
        h("button", { class: "ait-btn", type: "button", onClick: () => load() }, icon("refresh"), "Refresh"),
        status.el)));

  const pagers = [];
  function pager(label) {
    const previous = h("button", { class: "ait-btn ait-btn-sm", type: "button", disabled: true, onClick: () => navigate(-1) }, icon("chevronLeft"), "Previous");
    const next = h("button", { class: "ait-btn ait-btn-sm", type: "button", disabled: true, onClick: () => navigate(1) }, "Next", icon("chevronRight"));
    const where = h("span", { class: "ait-small ait-muted" });
    const size = select(["25", "50", "100"], String(pageSize));
    size.setAttribute("aria-label", `Jobs per page (${label})`);
    size.addEventListener("change", () => { pageSize = Number(size.value); pageNumber = 1; load(); });
    const el = h("nav", { class: "app-tool-actions app-tool-pager", "aria-label": `Job audit ${label} pagination` }, previous, where, next,
      h("label", { class: "ait-row ait-small" }, "Per page", size));
    pagers.push({ previous, next, where, size });
    return el;
  }

  function paging(loading, label) {
    for (const p of pagers) {
      p.previous.disabled = loading || pageNumber <= 1;
      p.next.disabled = loading || pageNumber * pageSize >= total;
      p.where.textContent = label;
      p.size.value = String(pageSize);
    }
  }

  function navigate(delta) {
    pageNumber += delta;
    load();
    filterForm.scrollIntoView({ block: "start" });
  }

  function jobCard(job) {
    let loaded = false;
    const body = h("div", { class: "app-tool-audit-body ait-stack-sm" });
    const card = h("details", { class: "app-tool-audit-job" },
      h("summary", { class: "app-tool-audit-row" },
        h("span", { class: "ait-ellipsis", title: job.ownerName || job.userId, text: job.ownerName || job.userId }),
        h("span", { class: "ait-ellipsis ait-muted", title: job.model, text: job.model }),
        h("span", { class: "ait-muted", text: job.status }),
        h("span", { class: "ait-small ait-muted", text: formatDateTime(job.createdAt) }),
        h("span", { class: "ait-ellipsis", title: job.promptPreview || "", text: job.promptPreview || "" })),
      h("div", { class: "app-tool-audit-detail ait-stack-sm" },
        h("p", { class: "ait-small ait-faint", text: [`Created ${formatDateTime(job.createdAt)}`, `started ${formatDateTime(job.startedAt)}`,
          `finished ${formatDateTime(job.completedAt)}`, job.workerLabel || "no instance", `attempts: ${job.attemptCount}`,
          job.progressMax > 0 ? `progress: ${job.progressValue}/${job.progressMax}` : ""].filter(Boolean).join(" · ") }),
        h("p", { class: "ait-small ait-faint ait-mono", text: job.id }),
        body));
    card.addEventListener("toggle", () => { if (card.open && !loaded) { loaded = true; loadDetail(job, body, () => { loaded = false; }); } });
    return card;
  }

  async function loadDetail(job, body, failed) {
    mount(body, h("p", { class: "ait-small ait-muted", text: "Loading details…" }));
    try {
      const detail = await api.get(`${OPERATE}/audit/${job.id}`);
      const facts = h("dl", { class: "ait-dl" });
      const row = (term, value) => facts.append(h("dt", { text: term }), h("dd", { text: value }));
      row("Owner", detail.ownerName || job.userId);
      row("Model", detail.modelLabel || job.model);
      row("Instance", detail.workerLabel || "—");
      row("API key", detail.apiKeyLabel || "—");
      const nested = [];
      for (const [key, value] of Object.entries(detail.job || {})) {
        if (value !== null && typeof value === "object") nested.push([key, value]);
        else row(key.replace(/_/g, " "), value == null ? "—" : String(value));
      }
      mount(body, facts, nested.map(([key, value]) => json(key.replace(/_/g, " "), value)), json("Complete stored job (JSON)", detail.job));
    } catch (err) {
      if (err?.status === 401) { reportError(err); return; }
      failed();
      mount(body, h("p", { class: "ait-small app-tool-error", text: err.status === 404 ? "This job is no longer available." : err.message }),
        h("button", { class: "ait-btn ait-btn-sm", type: "button", text: "Retry", onClick: () => loadDetail(job, body, failed) }));
    }
  }

  function json(label, value) {
    return h("details", { class: "app-tool-advanced" }, h("summary", { text: label }), h("pre", { class: "app-gen-pre", text: JSON.stringify(value, null, 2) }));
  }

  async function load() {
    const current = ++requestId;
    paging(true, "Loading…");
    mount(list, h("div", { class: "app-loading" }, h("div", { class: "ait-spinner" })));
    status.set("Loading the job audit…");
    const query = new URLSearchParams(filters);
    query.set("page", String(pageNumber));
    query.set("pageSize", String(pageSize));
    try {
      const result = await api.get(`${OPERATE}/audit?${query}`);
      if (current !== requestId || !isCurrent()) return;
      total = result.total;
      if (pageNumber > 1 && (pageNumber - 1) * pageSize >= total) {
        pageNumber = Math.max(1, Math.ceil(total / pageSize));
        return load();
      }
      mount(list, result.jobs.length ? [
        h("div", { class: "app-tool-audit-row app-tool-audit-heading", "aria-hidden": "true" },
          h("span", { text: "Member" }), h("span", { text: "Model" }), h("span", { text: "Status" }), h("span", { text: "Created" }), h("span", { text: "Prompt" })),
        ...result.jobs.map(jobCard)] : empty({ icon: "search", title: "No jobs", text: "No jobs match these filters." }));
      paging(false, `Page ${pageNumber} of ${Math.max(1, Math.ceil(total / pageSize))}`);
      status.set(total ? `${total} matching jobs. Times shown in your local timezone.` : "No jobs match these filters.");
    } catch (err) {
      if (current !== requestId) return;
      if (err?.status === 401) { reportError(err); return; }
      mount(list);
      status.set(err.message, true);
      paging(true, "");
    }
  }

  filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (search.value.trim()) next.set("search", search.value.trim());
    if (state.value) next.set("status", state.value);
    if (model.value.trim()) next.set("model", model.value.trim());
    if (from.value && to.value && from.value > to.value) { status.set("The end date must be on or after the start date.", true); return; }
    // The dates are the member's own days: from midnight on the first to midnight after the last.
    if (from.value) next.set("from", new Date(`${from.value}T00:00:00`).toISOString());
    if (to.value) {
      const end = new Date(`${to.value}T00:00:00`);
      end.setDate(end.getDate() + 1);
      next.set("to", end.toISOString());
    }
    filters = next;
    pageNumber = 1;
    load();
  });

  page.append(head,
    h("p", { class: "ait-muted", text: "Every retained generation job, across the GPU and cloud models, newest first. Open a job to see what is stored about it." }),
    filterForm, pager("top"), list, pager("bottom"));
  await load();
}
