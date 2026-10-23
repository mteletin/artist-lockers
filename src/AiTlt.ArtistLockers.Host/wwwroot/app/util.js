// Studio UI helpers: the signed-in context, the hash route, formatting and error toasts.
import { ApiError } from "/ai-tlt/ui/v1/api.js";
import { toast } from "/ai-tlt/ui/v1/components.js";

/** The signed-in context, filled by main.js: { me, isAdmin, legacySiteUrl }. */
export const ctx = { me: null, isAdmin: false, legacySiteUrl: "" };

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatDateTime(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dateTimeFmt.format(date) : "—";
}

/** 42 → "42s", 95 → "1:35". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Reads the hash route: "#/shared?tag=x" → { path: "/shared", params: URLSearchParams }. */
export function currentRoute() {
  const raw = location.hash.startsWith("#/") ? location.hash.slice(1) : "/";
  const [path, search = ""] = raw.split("?");
  return { path: path.replace(/\/+$/, "") || "/", params: new URLSearchParams(search) };
}

/** Shows an API error as a toast; a 401 reloads to the sign-in screen. */
export function reportError(err) {
  if (err instanceof ApiError && err.status === 401) { location.reload(); return; }
  toast(err?.message || "Something went wrong.", "error");
}
