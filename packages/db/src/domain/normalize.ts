/**
 * Deterministic, conservative normalization for the fingerprinting pipeline.
 *
 * Goal: stable grouping. Values that change between occurrences of the same
 * defect (IDs, timestamps, query strings, memory addresses, opaque tokens) are
 * replaced with typed placeholders. Ordinary values (status codes, versions,
 * small numbers, prose) are left intact on purpose: over-normalizing merges
 * different defects into a single issue, which is worse than splitting.
 *
 * Every rule here is narrow and unit-tested. Nothing in this module performs
 * I/O and nothing depends on the browser SDK.
 */

/** Typed placeholders used by the normalizer. Stable on purpose. */
export const NORMALIZED_PLACEHOLDER = {
  /** UUIDs, long decimal identifiers and numeric path segments. */
  id: ":id",
  /** ISO-8601 timestamps (with or without timezone). */
  timestamp: ":timestamp",
  /** Long hexadecimal identifiers. */
  hex: ":hex",
  /** Memory-address-like values (`0x...`). */
  address: ":addr",
  /** Long opaque alphanumeric tokens (session ids, cache-busters, JWTs parts). */
  token: ":token",
  /** Content hashes embedded in file names (`index-Bx3K9mPQ.js`). */
  hash: ":hash",
} as const;

const UUID_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const UUID_EXACT_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?/g;
const MEMORY_ADDRESS_PATTERN = /0x[0-9a-fA-F]{6,}/g;
const LONG_INTEGER_PATTERN = /\b\d{5,}\b/g;
const LONG_HEX_PATTERN = /\b[0-9a-fA-F]{8,}\b/g;
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\b/g;
const URL_LIKE_PATTERN =
  /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/\/|\/)[^\s"'`<>()[\]{}\\]+/g;

const NUMERIC_SEGMENT_PATTERN = /^\d{5,}$/;
const HEX_SEGMENT_PATTERN = /^[0-9a-fA-F]{8,}$/;
const OPAQUE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,8}$/;
const EMBEDDED_HASH_PATTERN =
  /([._-])([A-Za-z0-9]{6,})(?=\.[A-Za-z0-9]{1,8}$)/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]}"']+$/;

function containsAsciiDigit(value: string): boolean {
  return /[0-9]/.test(value);
}

function containsAsciiLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * Removes C0/C1 control characters so stored text can never carry them.
 */
export function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && (code < 0x7f || code > 0x9f)) {
      out += character;
    }
  }
  return out;
}

/**
 * Trims to a maximum length without splitting surrogate pairs.
 * Exported so descriptors can bound stored text deterministically.
 */
export function capText(value: string, maxLength: number): string {
  const cleaned = stripControlCharacters(value);
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const cut = cleaned.slice(0, maxLength);
  // Avoid cutting in the middle of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function splitTrailingPunctuation(value: string): {
  core: string;
  trailing: string;
} {
  const match = TRAILING_PUNCTUATION_PATTERN.exec(value);
  if (match === null) {
    return { core: value, trailing: "" };
  }
  return {
    core: value.slice(0, value.length - match[0].length),
    trailing: match[0],
  };
}

function stripQueryAndFragment(path: string): string {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  let end = path.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (hashIndex !== -1) end = Math.min(end, hashIndex);
  return path.slice(0, end);
}

/**
 * Normalizes one path segment:
 * - UUIDs, long decimal ids, long hex ids and long opaque tokens become typed
 *   placeholders;
 * - content hashes embedded in file names (`index-Bx3K9mPQ.js`) become `:hash`;
 * - everything else (route words, versions, short numbers) is preserved.
 */
export function normalizePathSegment(segment: string): string {
  if (segment === "" || segment === "." || segment === "..") {
    return segment;
  }
  if (UUID_EXACT_PATTERN.test(segment)) {
    return NORMALIZED_PLACEHOLDER.id;
  }
  if (NUMERIC_SEGMENT_PATTERN.test(segment)) {
    return NORMALIZED_PLACEHOLDER.id;
  }
  if (HEX_SEGMENT_PATTERN.test(segment) && containsAsciiDigit(segment)) {
    return NORMALIZED_PLACEHOLDER.hex;
  }
  if (
    OPAQUE_SEGMENT_PATTERN.test(segment) &&
    containsAsciiDigit(segment) &&
    containsAsciiLetter(segment)
  ) {
    return NORMALIZED_PLACEHOLDER.token;
  }
  if (FILE_EXTENSION_PATTERN.test(segment)) {
    return segment.replace(
      EMBEDDED_HASH_PATTERN,
      (match, separator: string, token: string) => {
        if (!containsAsciiDigit(token) || !containsAsciiLetter(token)) {
          return match;
        }
        return `${separator}${NORMALIZED_PLACEHOLDER.hash}`;
      },
    );
  }
  return segment;
}

/**
 * Normalizes a URL or route into a stable route string.
 *
 * Scheme, host and port are dropped (the same defect is grouped across
 * environments), the query string and fragment are dropped (they are request
 * parameters, not part of the defect), and unstable path segments are
 * replaced with placeholders.
 */
export function normalizePath(rawPath: string): string {
  let path = rawPath.trim();
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path);
  if (hasScheme || path.startsWith("//")) {
    const withoutScheme = hasScheme
      ? path.slice(path.indexOf("://") + 3)
      : path.slice(2);
    const slashIndex = withoutScheme.indexOf("/");
    path = slashIndex === -1 ? "/" : withoutScheme.slice(slashIndex);
  }
  path = stripQueryAndFragment(path);
  return path.split("/").map(normalizePathSegment).join("/");
}

/**
 * Normalizes a stack frame file name. Origin is dropped, query strings are
 * removed and unstable values (ids, hashes) are replaced.
 */
export function normalizeFilename(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed === "") {
    return "";
  }
  if (
    trimmed.startsWith("chrome-extension://") ||
    trimmed.startsWith("moz-extension://") ||
    trimmed.startsWith("safari-extension://")
  ) {
    return "browser-extension";
  }
  const { core } = splitTrailingPunctuation(trimmed);
  return normalizePath(core);
}

/**
 * Replaces unstable values inside an arbitrary message. Order matters:
 * URL/path tokens first (so route segments are normalized as paths), then
 * UUIDs, timestamps, memory addresses, long integers, long hex ids and
 * opaque tokens.
 *
 * Long hex ids only collapse when they contain at least one digit, so
 * ordinary words made of hexadecimal letters (`deadbeef`) stay intact.
 * Long integers require five or more digits, so status codes (`500`), ports
 * (`8080`) and four-digit years stay stable.
 */
export function normalizeMessage(message: string): string {
  let out = message.replace(/\s+/g, " ").trim();
  out = out.replace(URL_LIKE_PATTERN, (match) => {
    const { core, trailing } = splitTrailingPunctuation(match);
    return `${normalizePath(core)}${trailing}`;
  });
  out = out.replace(UUID_PATTERN, NORMALIZED_PLACEHOLDER.id);
  out = out.replace(ISO_TIMESTAMP_PATTERN, NORMALIZED_PLACEHOLDER.timestamp);
  out = out.replace(MEMORY_ADDRESS_PATTERN, NORMALIZED_PLACEHOLDER.address);
  out = out.replace(LONG_INTEGER_PATTERN, NORMALIZED_PLACEHOLDER.id);
  out = out.replace(LONG_HEX_PATTERN, (match) =>
    containsAsciiDigit(match) ? NORMALIZED_PLACEHOLDER.hex : match,
  );
  out = out.replace(OPAQUE_TOKEN_PATTERN, (match) =>
    containsAsciiDigit(match) && containsAsciiLetter(match)
      ? NORMALIZED_PLACEHOLDER.token
      : match,
  );
  return out;
}

/**
 * Minimal frame shape accepted by the normalizer. Mirrors the telemetry
 * contract without importing it, so symbolicated frames can be fed in later
 * without changing callers.
 */
export interface NormalizableStackFrame {
  filename?: string | undefined;
  function?: string | undefined;
  lineno?: number | undefined;
  colno?: number | undefined;
  in_app?: boolean | undefined;
}

export interface CanonicalStackFrame {
  function: string;
  file: string;
  line: number | null;
}

/**
 * Converts one frame into its canonical form. Returns null for frames that
 * carry no usable information at all.
 */
export function normalizeStackFrame(
  frame: NormalizableStackFrame,
): CanonicalStackFrame | null {
  const file = frame.filename ? normalizeFilename(frame.filename) : "";
  const rawFunction = frame.function?.trim() ?? "";
  if (file === "" && rawFunction === "") {
    return null;
  }
  const line =
    typeof frame.lineno === "number" && frame.lineno > 0 ? frame.lineno : null;
  return {
    function: rawFunction === "" ? "<anonymous>" : capText(rawFunction, 120),
    file,
    line,
  };
}

/** Stable textual form of a canonical frame used inside signatures. */
export function formatStackFrame(frame: CanonicalStackFrame): string {
  const location =
    frame.line === null ? frame.file : `${frame.file}:${frame.line}`;
  return `${frame.function}@${location}`;
}

/**
 * Selects up to `limit` canonical frames, preferring frames marked as
 * in-application. Falls back to the first usable frames when none are marked,
 * so an error is never left without a fingerprint just because `in_app` is
 * missing. Column numbers are intentionally excluded: they are unstable
 * across builds and would split otherwise identical defects.
 */
export function selectTopFrames(
  frames: readonly NormalizableStackFrame[],
  limit = 5,
): CanonicalStackFrame[] {
  const inApplication = frames.filter((frame) => frame.in_app === true);
  const source = inApplication.length > 0 ? inApplication : frames;
  const selected: CanonicalStackFrame[] = [];
  for (const frame of source) {
    const normalized = normalizeStackFrame(frame);
    if (normalized !== null) {
      selected.push(normalized);
    }
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}
