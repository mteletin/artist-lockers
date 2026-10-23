// AI-TLT UI v1 — fetch wrapper. Same-origin cookies, JSON in and out, the CSRF header on every non-GET.
// Failures throw ApiError {status, code, message, data}; a 204 resolves to null.

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message || code || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code || null;
    this.data = data || null;
  }
}

const FALLBACK_MESSAGES = {
  400: "That request was not valid.",
  401: "Your session has ended. Please sign in again.",
  403: "You don't have permission to do that.",
  404: "Not found.",
  409: "That change conflicts with the current state.",
  413: "That is too large.",
  415: "That file type is not supported.",
  429: "Too many requests. Please slow down and try again.",
  503: "The service is temporarily unavailable."
};

export async function request(method, path, body) {
  const headers = { Accept: "application/json" };
  const init = { method, credentials: "same-origin", headers };
  if (method !== "GET" && method !== "HEAD") {
    headers["X-AiTlt-Request"] = "1";
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }
  if (response.status === 204) return null;
  const type = response.headers.get("Content-Type") || "";
  const data = type.includes("json") ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    throw errorFrom(response.status, data);
  }
  return data;
}

/** The error a failed response carries; also for bodies fetch cannot send with progress (an upload). */
export function errorFrom(status, data) {
  const code = data?.code || data?.error || null;
  const message = data?.message || data?.detail || data?.title || FALLBACK_MESSAGES[status] || `Request failed (${status}).`;
  return new ApiError(status, code, message, data);
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  put: (path, body) => request("PUT", path, body),
  del: (path) => request("DELETE", path)
};

/** Builds a query string from an object, skipping empty values. */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
