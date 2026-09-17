/**
 * Origin allowlist parser: ORIGIN-only, no paths, no wildcards.
 *
 * Rules (Block 2):
 * - Input is trimmed; trailing slashes are removed for normalization.
 * - Must be a valid absolute URL with http: or https: only.
 *   javascript:, file:, data: and any other scheme are rejected.
 * - Must be ORIGIN-only: no path beyond "/", no query, no fragment,
 *   no username/password.
 * - No wildcards anywhere ("*" is always rejected, including the literal
 *   `http://localhost:*` pattern). Localhost dev origins must be explicit,
 *   e.g. `http://localhost:5173` — never a wildcard.
 * - Localhost rule (explicit dev only): `localhost`, `127.0.0.1` and `::1`
 *   are accepted but callers must only register them in development;
 *   production data must never rely on them. The parser itself accepts them
 *   so the dev seed and local demo work; policy/docs forbid prod use.
 * - Normalized form is lowercase scheme+host with explicit port preserved
 *   and no trailing slash: `https://example.com`, `http://localhost:5173`.
 */
export class OriginParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginParseError";
  }
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalhost(hostname: string): boolean {
  return LOCALHOST_HOSTS.has(hostname.toLowerCase());
}

export function isLocalhostOrigin(normalized: string): boolean {
  try {
    const url = new URL(normalized);
    return isLocalhost(url.hostname);
  } catch {
    return false;
  }
}

/** Parse and normalize a single origin string. Throws OriginParseError. */
export function parseOrigin(input: unknown): string {
  if (typeof input !== "string") {
    throw new OriginParseError("Origin must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new OriginParseError("Origin must not be empty");
  }
  if (trimmed.length > 2000) {
    throw new OriginParseError("Origin is too long");
  }
  if (trimmed.includes("*")) {
    throw new OriginParseError(
      "Wildcard origins are not allowed; register explicit origins",
    );
  }
  if (/\s/.test(trimmed)) {
    throw new OriginParseError("Origin must not contain whitespace");
  }

  // Strip trailing slashes for normalization, but remember whether the
  // original had a non-root path before stripping.
  const withoutTrailing = trimmed.replace(/\/+$/u, "");

  let url: URL;
  try {
    // If the input was only slashes after host (e.g. "...com///"), the
    // stripped form still parses; the original path check below uses URL.
    url = new URL(trimmed);
  } catch {
    throw new OriginParseError("Origin must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OriginParseError("Origin must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OriginParseError("Origin must not include credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new OriginParseError("Origin must not include query or fragment");
  }
  // ORIGIN-only: pathname must be empty or only slashes (root).
  if (url.pathname !== "" && !/^\/+$/.test(url.pathname)) {
    throw new OriginParseError("Origin must not include a path");
  }
  if (url.hostname.length === 0) {
    throw new OriginParseError("Origin must include a host");
  }

  // Normalize: scheme + lowercase host + explicit port, no trailing slash.
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = url.port !== "" ? `:${url.port}` : "";
  const normalized = `${protocol}//${hostname}${port}`;
  void withoutTrailing;
  void isLocalhost;
  return normalized;
}

/**
 * Validate an environment base_url (http/https only, path allowed).
 * Rejects javascript:, file:, data: and other schemes.
 */
export function parseBaseUrl(input: unknown): string {
  if (typeof input !== "string") {
    throw new OriginParseError("base_url must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new OriginParseError("base_url must not be empty");
  }
  if (trimmed.length > 2000) {
    throw new OriginParseError("base_url is too long");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OriginParseError("base_url must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OriginParseError("base_url must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OriginParseError("base_url must not include credentials");
  }
  // Remove trailing slash unless the path is exactly "/".
  if (
    trimmed.endsWith("/") &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  ) {
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  }
  return trimmed;
}
