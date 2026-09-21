/**
 * RS-08 `sourceMappingURL` handling (worker-side, text only).
 *
 * The trailing `sourceMappingURL` comment of an uploaded minified asset is
 * honored ONLY when it is a relative local same-release reference. Remote
 * values (`http:`, `https:`, `file:`, `ftp:`, `data:`, protocol-relative
 * `//`, or any other `scheme:` form) are recognized and ignored — never
 * fetched, never followed (no network, no SSRF). Absolute and escaping
 * references resolve to null for the same reason.
 *
 * This mirrors the CLI scanner's trust rules (RS-07) without importing it:
 * the worker is a separate trust domain and keeps its own small,
 * well-tested copy.
 */

import path from "node:path";

const SOURCE_MAPPING_URL_PATTERN = /sourceMappingURL\s*=\s*([^\s'"`)\\]+)/g;

/** True for values that must never be fetched (any remote/non-relative form). */
export function isRemoteSourceMappingUrl(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  if (trimmed.startsWith("//")) {
    return true;
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
}

/**
 * Extract the trailing `sourceMappingURL` value from minified asset text.
 * Returns the last match (the trailing comment wins) or null when absent.
 * Remote values are returned verbatim so callers can explicitly ignore
 * them — this function never fetches.
 */
export function parseTrailingSourceMappingURL(
  assetText: string,
): string | null {
  if (typeof assetText !== "string" || assetText === "") {
    return null;
  }
  SOURCE_MAPPING_URL_PATTERN.lastIndex = 0;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_MAPPING_URL_PATTERN.exec(assetText)) !== null) {
    const raw = match[1] ?? "";
    if (raw.trim() !== "") {
      last = raw.trim();
    }
  }
  return last;
}

/**
 * Resolve a map-relative reference (an asset `sourceMappingURL` or a map
 * `file` hint) against the referencing artifact's canonical path.
 * Returns the canonical same-release artifact path, or null when the
 * reference is remote, absolute, escaping or otherwise unsafe. Never fetches.
 */
export function resolveRelativeMapReference(
  fromArtifactPath: string,
  reference: string,
): string | null {
  if (typeof fromArtifactPath !== "string" || fromArtifactPath.trim() === "") {
    return null;
  }
  if (typeof reference !== "string") {
    return null;
  }
  const trimmed = reference.trim();
  if (trimmed === "") {
    return null;
  }
  const withoutFragment = trimmed.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const clean = withoutQuery.trim();
  if (clean === "") {
    return null;
  }
  if (clean.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) {
    return null;
  }
  // Absolute references are not relative-local: ignore them instead of
  // re-rooting under the asset directory.
  if (clean.startsWith("/")) {
    return null;
  }
  if (clean.includes("\\")) {
    return null;
  }
  const fromDir = fromArtifactPath.includes("/")
    ? (fromArtifactPath.slice(0, fromArtifactPath.lastIndexOf("/")) as string)
    : "";
  // Reject above-root escapes BEFORE normalizing: posix.normalize clamps
  // `..` at `/` silently, which would turn an out-of-release reference
  // into an innocent-looking root path. Track depth lexically instead.
  const baseDepth = fromDir === "" ? 0 : fromDir.split("/").length;
  let depth = baseDepth;
  for (const segment of clean.split("/")) {
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    } else if (segment !== "." && segment !== "") {
      depth += 1;
    }
  }
  const joined = path.posix.normalize(
    fromDir === "" ? `/${clean}` : `/${fromDir}/${clean}`,
  );
  if (joined === "/" || joined === "/.." || joined.startsWith("/../")) {
    return null;
  }
  const candidate = joined.slice(1);
  const segments = candidate.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    ) {
      return null;
    }
  }
  return candidate;
}
