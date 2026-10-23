// AI-TLT UI v1 — DOM helpers, icons and custom elements. No product knowledge, no innerHTML with data.
//   h(tag, attrs, ...children)   safe element builder
//   icon(name)                   inline SVG (stroke = currentColor)
//   <ait-avatar src name size shape>   image with initials fallback
//   <ait-role-chip label system compact>  a role badge; [system] marks it "automatic" ([compact]: icon only)
//   <ait-empty icon title text>        empty state; child elements become its actions
//   toast(message, kind), confirmDialog({...}), openDialog({...})

const SVG_NS = "http://www.w3.org/2000/svg";

/** Builds an element. attrs: class, text, on<Event> handlers, dataset, boolean/string attributes. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== "string" && key !== "list") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replaces an element's children. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const ICONS = {
  user: ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"],
  users: ["M17 21a6 6 0 0 0-12 0", "M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21a5 5 0 0 0-4-4.9", "M16 3.1a4 4 0 0 1 0 7.8"],
  id: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M9 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M6 16a3 3 0 0 1 6 0", "M15 10h3", "M15 14h3"],
  music: ["M9 18V5l12-2v13", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  mask: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 10h.01", "M16 10h.01", "M8.5 15a4 4 0 0 0 7 0"],
  shield: ["M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"],
  key: ["M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7z", "M16 8h.01"],
  list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  lock: ["M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z", "M8 11V7a4 4 0 0 1 8 0v4"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16v-4", "M12 8h.01"],
  alert: ["M12 3l10 18H2z", "M12 10v4", "M12 17h.01"],
  plus: ["M12 5v14", "M5 12h14"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"],
  archive: ["M3 4h18v4H3z", "M5 8v12h14V8", "M10 12h4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  logout: ["M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4", "M10 17l5-5-5-5", "M15 12H3"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  check: ["M5 12l5 5L20 7"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronLeft: ["M15 18l-6-6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  ban: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M5.6 5.6l12.8 12.8"],
  refresh: ["M20 11a8 8 0 0 0-14.9-4", "M4 4v4h4", "M4 13a8 8 0 0 0 14.9 4", "M20 20v-4h-4"],
  sun: ["M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1v2", "M12 21v2", "M4.2 4.2l1.4 1.4", "M18.4 18.4l1.4 1.4", "M1 12h2", "M21 12h2", "M4.2 19.8l1.4-1.4", "M18.4 5.6l1.4-1.4"],
  moon: ["M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3a14 14 0 0 1 0 18", "M12 3a14 14 0 0 0 0 18"],
  image: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 20"],
  video: ["M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M16 10l5-3v10l-5-3"],
  play: ["M7 4l13 8-13 8z"],
  copy: ["M9 9h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3"],
  share: ["M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M8.6 13.5l6.8 4", "M15.4 6.5l-6.8 4"],
  frame: ["M4 4h16v16H4z", "M4 9h16", "M9 4v5", "M15 4v5", "M10 13l5 3-5 3z"],
  sparkles: ["M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z", "M19 3v4", "M21 5h-4"],
  grid: ["M4 4h3v3H4z", "M10.5 4h3v3h-3z", "M17 4h3v3h-3z", "M4 10.5h3v3H4z", "M10.5 10.5h3v3h-3z", "M17 10.5h3v3h-3z", "M4 17h3v3H4z", "M10.5 17h3v3h-3z", "M17 17h3v3h-3z"],
  terminal: ["M4 17l6-6-6-6", "M12 19h8"]
};

/** Inline SVG icon; aria-hidden unless a label is given. */
export function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); }
  else svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || ICONS.info) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Discord's mark, filled with currentColor. */
export function discordIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7zM8 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z");
  svg.append(path);
  return svg;
}

/** Up to two initials from a display name. */
export function initials(name) {
  const words = String(name || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] || "";
  const second = words.length > 1 ? [...words[words.length - 1]][0] || "" : [...words[0]][1] || "";
  return (first + second).toUpperCase();
}

class AitAvatar extends HTMLElement {
  static observedAttributes = ["src", "name"];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const src = this.getAttribute("src");
    const name = this.getAttribute("name") || "";
    const fallback = () => mount(this, h("span", { "aria-hidden": "true", text: initials(name) }));
    if (!this.hasAttribute("role")) this.setAttribute("role", "img");
    this.setAttribute("aria-label", name || "avatar");
    if (!src) { fallback(); return; }
    const img = h("img", { src, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", fallback, { once: true });
    mount(this, img);
  }
}

class AitRoleChip extends HTMLElement {
  static observedAttributes = ["label", "system", "compact"];
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const system = this.hasAttribute("system");
    const compact = this.hasAttribute("compact");
    const label = this.getAttribute("label") || "";
    const description = this.getAttribute("description");
    const title = [description, system ? "Automatic: set by a product" : null].filter(Boolean).join(" — ");
    mount(this, h("span", { class: `ait-badge ${system ? "ait-badge-info" : "ait-badge-accent"}`, title: title || undefined },
      system ? icon("refresh") : null,
      label,
      system && !compact ? h("span", { class: "ait-role-chip-auto", text: "· automatic" }) : null,
      system && compact ? h("span", { class: "ait-sr-only", text: " (automatic)" }) : null));
  }
}

class AitEmpty extends HTMLElement {
  connectedCallback() {
    if (this.dataset.ready) return;
    this.dataset.ready = "1";
    const actions = [...this.children];
    mount(this,
      h("div", { class: "ait-empty-icon" }, icon(this.getAttribute("icon") || "info")),
      h("div", { class: "ait-empty-title", text: this.getAttribute("heading") || "" }),
      this.getAttribute("text") ? h("p", { class: "ait-small", text: this.getAttribute("text") }) : null,
      actions.length ? h("div", { class: "ait-empty-actions ait-row" }, actions) : null);
  }
}

/** A toast host; toast() creates one on demand. */
class AitToast extends HTMLElement {
  connectedCallback() {
    this.classList.add("ait-toasts");
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Notifications");
    this.setAttribute("aria-live", "polite");
  }
  show(message, kind = "info", timeout = 5000) {
    const close = h("button", { class: "ait-btn ait-btn-ghost ait-btn-sm", type: "button", "aria-label": "Dismiss" }, icon("close"));
    const item = h("div", { class: `ait-toast ait-toast-${kind}`, role: kind === "error" ? "alert" : "status" },
      h("span", { text: message }), close);
    const remove = () => item.remove();
    close.addEventListener("click", remove);
    this.append(item);
    if (timeout) setTimeout(remove, kind === "error" ? timeout * 1.6 : timeout);
  }
}

customElements.define("ait-avatar", AitAvatar);
customElements.define("ait-role-chip", AitRoleChip);
customElements.define("ait-empty", AitEmpty);
customElements.define("ait-toast", AitToast);

export function avatar(src, name, size) {
  return h("ait-avatar", { src: src || undefined, name: name || "", size: size || undefined });
}

/** The AI-TLT apps one account opens, as a segmented switch; the app showing it is marked current. Signing in to one signs in
 *  to the others through accounts.ai-tlt.eu. apps: [{ name, url, current }]. */
export function appSwitcher(apps) {
  if (!apps || apps.length < 2) return null;
  return h("nav", { class: "ait-apps", "aria-label": "AI-TLT apps" }, apps.map((app) => app.current
    ? h("span", { class: "ait-apps-item", "aria-current": "true", text: app.name })
    : h("a", { class: "ait-apps-item", href: app.url, text: app.name })));
}

export const PLATFORM_APPS = [
  {
    id: "studio",
    name: "AI-TLT Studio",
    url: "https://studio.ai-tlt.eu/",
    description: "Creative workspace, high-resolution media library, prompt & video generation, team writing boards, and lore codex.",
    icon: "video"
  },
  {
    id: "mobvision",
    name: "Mobvision",
    url: "https://mobvision.eu/",
    description: "Music and AI video contest platform with community charts, creator profiles, and participatory voting.",
    icon: "music"
  },
  {
    id: "accounts",
    name: "AI-TLT Accounts",
    url: "https://accounts.ai-tlt.eu/",
    description: "Central creator identity, personas, linked artist entities, security credentials, and platform roles.",
    icon: "user"
  },
  {
    id: "mcp",
    name: "MCP Hub",
    url: "https://mcp.ai-tlt.eu/",
    description: "Model Context Protocol gateway multiplexing specialized endpoints for Claude and ChatGPT AI coding agents.",
    icon: "key"
  },
  {
    id: "artistlockers",
    name: "Artist Lockers",
    url: "https://artistlockers.eu/",
    description: "Decentralized creator asset vaults, verifiable digital lockers, and protected media licensing pipelines.",
    icon: "lock",
    comingSoon: true
  }
];

/**
 * Dynamic AI-TLT Platform App Launcher: quick pills + 9-dot waffle popover.
 * Only authenticated server-provided entries are displayed; an empty list clears the launcher.
 */
export function appLauncher(apps = [], { currentApp = "", quickPills = false, portalUrl = "https://ai-tlt.eu/" } = {}) {
  const container = h("div", { class: "ait-launcher" });

  const mergeApps = (incoming) => {
    const result = Array.isArray(incoming) ? incoming.filter(app => app?.id).map(app => ({ ...app })) : [];
    for (const app of result) {
      if (app.id === currentApp) app.current = true;
    }
    return result;
  };

  let currentList = mergeApps(apps);

  const pillsContainer = h("div", { class: "ait-launcher-pills" });

  const renderPills = (items) => {
    if (!quickPills || !items || items.length < 2) {
      pillsContainer.replaceChildren();
      return;
    }
    const pills = items.slice(0, 3).map((app) => {
      const isCur = !!app.current || (currentApp && (app.id === currentApp || app.name?.toLowerCase() === currentApp.toLowerCase()));
      return isCur
        ? h("span", { class: "ait-apps-item", "aria-current": "true", text: app.name })
        : h("a", { class: "ait-apps-item", href: app.url, text: app.name });
    });
    mount(pillsContainer, h("nav", { class: "ait-apps", "aria-label": "Quick app switcher" }, pills));
  };

  const button = h("button", {
    class: "ait-launcher-btn",
    type: "button",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "aria-label": "AI-TLT Platform Apps",
    title: "AI-TLT Apps"
  }, icon("grid"));

  const popover = h("div", { class: "ait-launcher-popover ait-menu", role: "menu", hidden: true });

  const renderPopover = (items) => {
    const list = items || [];
    mount(popover,
      h("div", { class: "ait-launcher-head" },
        h("div", { class: "ait-launcher-brand" },
          icon("globe"),
          h("strong", { text: "AI-TLT Platform" })),
        h("span", { class: "ait-launcher-sub", text: "Connected apps & services" })),
      h("div", { class: "ait-menu-sep" }),
      h("div", { class: "ait-launcher-grid" },
        list.map((app) => {
          const isCur = !!app.current || (currentApp && (app.id === currentApp || app.name?.toLowerCase() === currentApp.toLowerCase()));
          return h("a", {
            class: `ait-launcher-card ${isCur ? "is-current" : ""} ${app.comingSoon ? "is-disabled" : ""}`,
            href: app.comingSoon ? "#" : app.url,
            onClick: app.comingSoon ? (e) => e.preventDefault() : undefined,
            role: "menuitem"
          },
            h("div", { class: "ait-launcher-card-icon" }, icon(app.icon || "globe")),
            h("div", { class: "ait-launcher-card-body" },
              h("div", { class: "ait-launcher-card-name" },
                h("span", { text: app.name }),
                isCur ? h("span", { class: "ait-badge ait-badge-accent ait-badge-sm", text: "Current" }) : null,
                app.comingSoon ? h("span", { class: "ait-badge ait-badge-info ait-badge-sm", text: "Soon" }) : null),
              app.description ? h("div", { class: "ait-launcher-card-desc", text: app.description }) : null));
        })),
      h("div", { class: "ait-menu-sep" }),
      h("a", { class: "ait-launcher-footer", href: portalUrl, role: "menuitem" },
        icon("globe"),
        h("span", { class: "ait-grow", text: "Platform Home Portal" }),
        icon("external")));
  };

  renderPills(currentList);
  renderPopover(currentList);

  const close = () => {
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = popover.hidden;
    popover.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", (event) => {
    if (!container.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) close();
  });

  if (quickPills) container.append(pillsContainer);
  container.append(button, popover);

  container.updateApps = (newApps) => {
    if (Array.isArray(newApps)) {
      currentList = mergeApps(newApps);
      renderPills(currentList);
      renderPopover(currentList);
    }
  };

  return container;
}

export function roleChip(role, { compact = false } = {}) {
  return h("ait-role-chip", { label: role.displayName || role.key, system: role.systemManaged || undefined,
    compact: compact || undefined, description: role.description || undefined });
}

export function empty({ icon: iconName, title, text }, ...actions) {
  return h("ait-empty", { icon: iconName, heading: title, text }, ...actions);
}

export function toast(message, kind = "info") {
  let host = document.querySelector("ait-toast");
  if (!host) { host = h("ait-toast"); document.body.append(host); }
  host.show(message, kind);
}

/**
 * Opens a modal dialog. body is a node (or array); onSubmit(form) may throw to keep the dialog open,
 * or return false. Resolves with the submit result, or null when cancelled.
 */
export function openDialog({ title, description, body, submitLabel = "Save", cancelLabel = "Cancel", danger = false, onSubmit, hideSubmit = false }) {
  return new Promise((resolve) => {
    const titleId = `ait-dlg-${Math.random().toString(36).slice(2)}`;
    const submit = h("button", { class: `ait-btn ${danger ? "ait-btn-danger" : "ait-btn-primary"}`, type: "submit", text: submitLabel });
    const cancel = h("button", { class: "ait-btn", type: "button", value: "cancel", text: cancelLabel });
    const error = h("div", { class: "ait-banner ait-banner-danger", role: "alert", hidden: true });
    const form = h("form", { method: "dialog", novalidate: true },
      h("div", { class: "ait-dialog-head ait-stack-sm" },
        h("h2", { id: titleId, text: title }),
        description ? h("p", { class: "ait-muted ait-small", text: description }) : null),
      h("div", { class: "ait-dialog-body" }, error, body),
      h("div", { class: "ait-dialog-foot" }, cancel, hideSubmit ? null : submit));
    const dialog = h("dialog", { class: "ait-dialog", "aria-labelledby": titleId }, form);
    let result = null;
    const close = () => { dialog.close(); };
    cancel.addEventListener("click", close);
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!onSubmit) { result = true; close(); return; }
      submit.disabled = true;
      error.hidden = true;
      try {
        const value = await onSubmit(form);
        if (value === false) return;
        result = value === undefined ? true : value;
        close();
      } catch (err) {
        mount(error, icon("alert"), h("span", { text: err?.message || "Something went wrong." }));
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    const first = form.querySelector(".ait-dialog-body input, .ait-dialog-body textarea, .ait-dialog-body select");
    (first || submit).focus();
  });
}

/** Asks for confirmation; resolves true or false. */
export async function confirmDialog({ title, message, confirmLabel = "Confirm", danger = true }) {
  const ok = await openDialog({ title, body: h("p", { class: "ait-muted", text: message }), submitLabel: confirmLabel, danger });
  return ok === true;
}
