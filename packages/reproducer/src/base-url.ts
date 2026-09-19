/* eslint-disable no-control-regex -- intentional control-character handling for safe code generation */
import { stripControlChars } from "./escaping.js";

export const REPRODUCTION_BASE_URL_REQUIRED = "REPRODUCTION_BASE_URL_REQUIRED";
export const REPRODUCTION_UNSUPPORTED_FAILURE =
  "REPRODUCTION_UNSUPPORTED_FAILURE";
export const REPRODUCTION_OUTPUT_TOO_LARGE = "REPRODUCTION_OUTPUT_TOO_LARGE";
export const REPRODUCTION_INVALID_EVIDENCE = "REPRODUCTION_INVALID_EVIDENCE";

export class ReproductionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReproductionError";
    this.code = code;
  }
}

/** Sensitive query params are dropped from generated routes. */
const SENSITIVE_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "key",
  "api_key",
  "password",
  "secret",
  "auth",
  "code",
  "client_secret",
  "client_id",
  "authorization",
  "bearer",
  "jwt",
  "session_id",
  "sessionid",
  "sid",
  "csrf",
  "xsrf",
  "_token",
]);

const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;

export interface ValidatedBaseUrl {
  /** Normalized origin, no trailing slash (except root is origin only). */
  origin: string;
}

function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/**
 * Validate + normalize a project environment base URL.
 * Emitted into code only; the server never browses to it.
 */
export function validateBaseUrl(raw: string): ValidatedBaseUrl {
  const trimmed = stripControlChars(raw).trim();
  if (trimmed === "" || CONTROL_RE.test(raw)) {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL is required and must not contain control characters.",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL is invalid.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL must use http or https.",
    );
  }
  if (hasCredentials(url)) {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL must not contain credentials.",
    );
  }
  if (url.hash !== "") {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL must not contain a fragment.",
    );
  }
  if (trimmed.length > 2000) {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Base URL is too long.",
    );
  }
  // Normalize: origin only (path/query on a base URL are ignored
  // deliberately; startRoute carries the path). Lowercase host via URL.
  const origin = `${url.protocol}//${url.host}`;
  return { origin };
}

/**
 * Sanitize a timeline navigation target into a same-origin relative
 * route (path + safe query). Returns null when unsafe/unsalvageable.
 */
export function sanitizeRoute(rawUrl: string): string | null {
  const trimmed = stripControlChars(rawUrl).trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  for (const scheme of ["javascript:", "data:", "file:", "ftp:", "vbscript:"]) {
    if (lower.startsWith(scheme)) return null;
  }
  if (CONTROL_RE.test(trimmed)) return null;
  // Relative route: must start with / and contain no scheme/host.
  if (trimmed.startsWith("/")) {
    return sanitizeRelativeRoute(trimmed);
  }
  // Absolute URL: accept only http/https, then reduce to relative route.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const relative = `${url.pathname}${url.search}`;
  return sanitizeRelativeRoute(relative);
}

function sanitizeRelativeRoute(relative: string): string | null {
  if (!relative.startsWith("/")) return null;
  if (relative.includes("\\") || CONTROL_RE.test(relative)) return null;
  // Split path/query; drop sensitive query params, keep the rest bounded.
  const qIndex = relative.indexOf("?");
  const path = qIndex === -1 ? relative : relative.slice(0, qIndex);
  if (path.length > 1024) return null;
  if (qIndex === -1) return path === "" ? "/" : path;
  const query = relative.slice(qIndex + 1);
  const params = new URLSearchParams(query);
  const kept: Array<[string, string]> = [];
  // Deterministic order: sort by name.
  const names: string[] = [];
  params.forEach((_v, k) => {
    if (!names.includes(k)) names.push(k);
  });
  names.sort();
  for (const name of names) {
    if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) continue;
    const values = params.getAll(name);
    for (const v of values) {
      if (name.length > 128 || v.length > 512) continue;
      if (CONTROL_RE.test(name) || CONTROL_RE.test(v)) continue;
      kept.push([name, v]);
    }
    if (kept.length > 20) break;
  }
  if (kept.length === 0) return path === "" ? "/" : path;
  const out = new URLSearchParams();
  for (const [k, v] of kept) out.append(k, v);
  const qs = out.toString();
  const full = `${path}?${qs}`;
  return full.length > 2048 ? path : full;
}

/** Normalize a network path for assertion matching (query-insensitive). */
export function normalizeNetworkPath(rawUrl: string): string | null {
  const route = sanitizeRoute(rawUrl);
  if (route === null) return null;
  const q = route.indexOf("?");
  return q === -1 ? route : route.slice(0, q);
}
