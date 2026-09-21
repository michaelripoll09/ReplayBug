/**
 * Upload policy (RS-06 shared home).
 *
 * JS symbolication is the goal, so the extension allowlist is exactly
 * `.map/.js/.mjs/.cjs` (`.css` stays out — stylesheets never symbolicate;
 * `.exe/.html/.svg` and renamed binaries/markup are rejected). MIME
 * checks tolerate realistic CLI multipart types (`application/octet-stream`
 * defaults, explicit `application/json` / `text/javascript`, empty
 * content types) while extension and content rules stay authoritative:
 * a dangerous MIME on an allowlisted extension still fails.
 *
 * Content sniffing (`detectProhibitedContent`) is a best-effort guard for
 * binaries/markup renamed to an allowed extension — MZ/ELF magic bytes
 * and leading `<!doctype`/`<html`/`<svg` on non-map assets. `.map`
 * uploads face the stricter `validateSourceMapBytes` instead.
 */
import { InvalidArtifactTypeError } from "./errors.js";

export const ALLOWED_ARTIFACT_EXTENSIONS = [
  ".map",
  ".js",
  ".mjs",
  ".cjs",
] as const;

export type AllowedArtifactExtension =
  (typeof ALLOWED_ARTIFACT_EXTENSIONS)[number];

/** Preflight manifest cap: bounded list per request. */
export const PREFLIGHT_MAX_ENTRIES = 500;

/** Aggregate declared-bytes cap across one preflight manifest. */
export const UPLOAD_AGGREGATE_MAX_BYTES = 250 * 1024 * 1024;

export type UploadArtifactType = "source_map" | "minified_asset";

/**
 * MIME types a real CLI multipart sender plausibly emits (matched
 * case-insensitively, parameters stripped). Absent/empty content types
 * are tolerated; anything else on an upload fails.
 */
const TOLERATED_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/json",
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
  "text/plain",
]);

/** Bytes inspected for magic-byte/markup prefixes. */
const SNIFF_WINDOW_BYTES = 512;

function fail(message: string): never {
  throw new InvalidArtifactTypeError(message);
}

/** Lowercased extension (with dot) of a canonical artifact path. */
export function extensionOfArtifactPath(canonicalPath: string): string {
  const base = canonicalPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

/** Extension → artifact type; throws for anything not allowlisted. */
export function artifactTypeForExtension(
  extension: string,
): UploadArtifactType {
  if (extension === ".map") {
    return "source_map";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "minified_asset";
  }
  fail(`Artifact extension "${extension || "(none)"}" is not allowed`);
}

/** Assert a canonical path carries an allowlisted extension; return it. */
export function validateArtifactExtension(
  canonicalPath: string,
): AllowedArtifactExtension {
  const extension = extensionOfArtifactPath(canonicalPath);
  artifactTypeForExtension(extension);
  return extension as AllowedArtifactExtension;
}

function normalizeMimeType(mimeType: unknown): string | null {
  if (typeof mimeType !== "string") {
    return null;
  }
  const trimmed = mimeType.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.split(";")[0]?.trim().toLowerCase() ?? null;
}

/**
 * Tolerate realistic CLI multipart content types while enforcing the
 * extension/content rules. Absent or empty MIME is accepted (many
 * senders omit it); anything outside the tolerated set fails.
 */
export function validateArtifactMimeType(
  mimeType: unknown,
  _extension: string,
): void {
  const normalized = normalizeMimeType(mimeType);
  if (normalized === null) {
    return;
  }
  if (!TOLERATED_MIME_TYPES.has(normalized)) {
    fail(`Artifact MIME type "${normalized}" is not allowed`);
  }
}

export type ProhibitedContent = "executable" | "markup";

/**
 * Best-effort content sniff over the leading bytes: MZ/ELF executables
 * and `<!doctype`/`<html`/`<svg` markup renamed to asset extensions.
 * Returns the hit kind, or null when the prefix looks like code/text.
 */
export function detectProhibitedContent(
  bytes: Uint8Array,
): ProhibitedContent | null {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return "executable";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return "executable";
  }
  const head = asciiHead(bytes);
  if (
    /^<!doctype\b/i.test(head) ||
    /^<html\b/i.test(head) ||
    /^<svg\b/i.test(head)
  ) {
    return "markup";
  }
  return null;
}

/** Throw `InvalidArtifactTypeError` when the prefix sniffs prohibited. */
export function assertSafeAssetContent(bytes: Uint8Array): void {
  const hit = detectProhibitedContent(bytes);
  if (hit === "executable") {
    fail("Artifact content looks like an executable binary");
  }
  if (hit === "markup") {
    fail("Artifact content looks like HTML/SVG markup");
  }
}

function asciiHead(bytes: Uint8Array): string {
  const window = bytes.slice(0, SNIFF_WINDOW_BYTES);
  let start = 0;
  // Skip UTF-8 BOM + ASCII whitespace before matching markup opens.
  if (
    window.length >= 3 &&
    window[0] === 0xef &&
    window[1] === 0xbb &&
    window[2] === 0xbf
  ) {
    start = 3;
  }
  let text = "";
  for (let i = start; i < window.length; i += 1) {
    const byte = window[i] as number;
    if (byte >= 0x80) {
      break;
    }
    text += String.fromCharCode(byte);
    if (text.length > 32) {
      break;
    }
  }
  return text.trimStart();
}
