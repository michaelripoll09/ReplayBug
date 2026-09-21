/**
 * RS-08 generated-URL normalization (worker-side, string ops only).
 *
 * Browser `filename` values become generated artifact paths for the
 * same-release lookup: strip the origin, query string and hash fragment,
 * keep Vite hashed assets verbatim (`assets/index-C8bf2.js` — the exact
 * uploaded path is required; hash placeholder normalization belongs to
 * fingerprinting, never to symbolication lookup).
 *
 * Pure function: no I/O, no fetching, no execution. Returns null when the
 * input cannot name an uploaded artifact (`data:`/`blob:` URLs, empty
 * input, traversal/backslash/dot-segment escapes).
 */

const DATA_OR_BLOB_PATTERN = /^(data|blob):/i;

/**
 * Normalize a browser frame filename to a POSIX relative generated
 * artifact path, or null when it cannot name an uploaded artifact.
 */
export function normalizeGeneratedUrl(filename: string): string | null {
  if (typeof filename !== "string") {
    return null;
  }
  let value = filename.trim();
  if (value === "") {
    return null;
  }
  if (DATA_OR_BLOB_PATTERN.test(value)) {
    return null;
  }

  // Strip hash then query (both are cache-busters, never part of the path).
  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) {
    value = value.slice(0, hashIndex);
  }
  const queryIndex = value.indexOf("?");
  if (queryIndex !== -1) {
    value = value.slice(0, queryIndex);
  }
  value = value.trim();
  if (value === "") {
    return null;
  }

  // Strip scheme://host and protocol-relative //host prefixes.
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(value);
  if (schemeMatch !== null) {
    const withoutScheme = value.slice(schemeMatch[0].length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex === -1) {
      return null;
    }
    value = withoutScheme.slice(slashIndex);
  } else if (value.startsWith("//")) {
    const withoutSlashes = value.slice(2);
    const slashIndex = withoutSlashes.indexOf("/");
    if (slashIndex === -1) {
      return null;
    }
    value = withoutSlashes.slice(slashIndex);
  }

  // Absolute paths become relative; anything else stays as-is.
  if (value.startsWith("/")) {
    value = value.slice(1);
  }
  if (value === "") {
    return null;
  }

  // Reject escapes and non-POSIX shapes before they reach the DB lookup.
  if (value.includes("\\")) {
    return null;
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return null;
    }
  }
  return value;
}
