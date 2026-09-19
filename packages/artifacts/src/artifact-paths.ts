/**
 * Upload-path canonicalization (RS-06 shared home).
 *
 * Both the API upload pipeline and the future CLI (RS-07) import this
 * module so traversal rules live in exactly one place. User-supplied
 * `artifactPath` values become canonical POSIX relative paths ONLY after
 * containment inside the upload root is proven — hostile input is
 * REJECTED, never normalized into something loadable.
 *
 * Rejected shapes: `..` segments at any depth (`../foo`,
 * `foo/../../bar`), absolute POSIX (`/foo`), Windows drive (`C:\foo`,
 * `C:/foo`, `C:foo`), UNC (`\\server\share`, `//server/share`), Windows
 * reserved names (`NUL`, with or without extension, any case), empty
 * input, NUL/control characters, over-long paths/segments, trailing
 * dot/space segments, and percent-encoded variants of any of the above
 * (decoded up to three rounds before validation, so `%2e%2e/foo` and
 * `%252e%252e/foo` both fail).
 *
 * Symlink note: string canonicalization cannot see symlinks. Use
 * `assertNoSymlinkEscape` wherever a canonical path is resolved against a
 * real directory that may contain attacker-influenced links (CLI scan
 * roots in RS-07); it fail-closes on dangling links.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ArtifactPathError } from "./errors.js";

export const ARTIFACT_PATH_MAX_LENGTH = 1024;
const ARTIFACT_PATH_SEGMENT_MAX_LENGTH = 255;

/** Windows reserved basenames (compared case-insensitively, pre-extension). */
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export interface CanonicalizeOptions {
  /**
   * When provided, the canonical result is additionally resolved against
   * this root and proven contained (defense in depth — canonical forms
   * cannot escape by construction, but the proof runs anyway).
   */
  uploadRoot?: string;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Decode percent-encodings iteratively (up to three rounds) so single-
 * and double-encoded traversal (`%2e%2e/`, `%252e%252e/`) converges to
 * the same hostile string before validation. Invalid encodings (lone
 * `%`, as in `100%.map`) are kept verbatim — the literal form is then
 * judged on its own merits.
 */
function decodePercentEncodings(value: string): string {
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    if (!current.includes("%")) {
      return current;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) {
        return current;
      }
      current = decoded;
    } catch {
      return current;
    }
  }
  return current;
}

function fail(message: string): never {
  throw new ArtifactPathError(message);
}

/**
 * Canonicalize a user-supplied artifact path to a POSIX relative path.
 * Throws `ArtifactPathError` for every hostile or malformed shape.
 */
export function canonicalizeArtifactPath(
  input: unknown,
  options: CanonicalizeOptions = {},
): string {
  if (typeof input !== "string") {
    fail("Artifact path must be a string");
  }
  const raw = input as string;
  if (raw.length === 0) {
    fail("Artifact path must not be empty");
  }
  if (raw.includes(String.fromCharCode(0)) || hasControlChars(raw)) {
    fail("Artifact path contains invalid characters");
  }
  // Decode first so encoded separators/reserved shapes face the same
  // checks as their literal equivalents.
  const decoded = decodePercentEncodings(raw);
  if (decoded.includes(String.fromCharCode(0)) || hasControlChars(decoded)) {
    fail("Artifact path contains invalid characters");
  }
  // Normalize Windows separators (including decoded `%5C`) to POSIX.
  const slashed = decoded.replace(/\\/g, "/");
  if (slashed.length === 0 || slashed.length > ARTIFACT_PATH_MAX_LENGTH) {
    fail(`Artifact path must be 1-${ARTIFACT_PATH_MAX_LENGTH} characters`);
  }
  if (slashed.startsWith("/")) {
    fail("Artifact path must be relative, not absolute");
  }
  if (/^[A-Za-z]:/.test(slashed)) {
    fail("Artifact path must not be a Windows drive path");
  }
  const segments = slashed.split("/");
  const canonical: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) {
      fail("Artifact path contains an empty segment");
    }
    if (segment === "." || segment === "..") {
      fail("Artifact path must not contain dot segments");
    }
    if (segment.length > ARTIFACT_PATH_SEGMENT_MAX_LENGTH) {
      fail("Artifact path contains an over-long segment");
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      fail("Artifact path segment must not end with a dot or space");
    }
    const base = segment.split(".")[0] ?? "";
    if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
      fail("Artifact path uses a reserved device name");
    }
    canonical.push(segment);
  }
  const result = canonical.join("/");
  if (result.length === 0 || result.length > ARTIFACT_PATH_MAX_LENGTH) {
    fail(`Artifact path must be 1-${ARTIFACT_PATH_MAX_LENGTH} characters`);
  }
  if (options.uploadRoot !== undefined) {
    resolveArtifactUploadPath(options.uploadRoot, result);
  }
  return result;
}

/**
 * Resolve an already-canonical path against `root` and prove containment:
 * the result must stay strictly inside `root`. Throws
 * `ArtifactPathError` otherwise. Canonical inputs pass by construction;
 * the proof exists so future callers cannot regress by skipping
 * canonicalization.
 */
export function resolveArtifactUploadPath(
  root: string,
  canonicalPath: string,
): string {
  if (typeof root !== "string" || root.length === 0) {
    fail("Upload root must be a non-empty path");
  }
  // Re-validate: this function must never trust its caller.
  const canonical = canonicalizeArtifactPath(canonicalPath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...canonical.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("Artifact path escapes the upload root");
  }
  return resolved;
}

/**
 * Fail-closed symlink guard for resolving a canonical path against a real
 * directory: walk each level top-down, realpath it through any links
 * (symlinks AND Windows junctions — `realpath` sees both, `lstat`
 * alone would miss junctions), and prove every resolved level stays
 * inside the realpath of `root`. Planted links (`link/` → outside) and
 * dangling links (whose target cannot be resolved) both throw
 * `ArtifactPathError`. Fresh targets stop at the first non-existent
 * level — lexical containment (proven by `resolveArtifactUploadPath`)
 * is the strongest claim available there.
 */
export async function assertNoSymlinkEscape(
  root: string,
  canonicalPath: string,
): Promise<void> {
  const target = resolveArtifactUploadPath(root, canonicalPath);
  const resolvedRoot = path.resolve(root);
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    // A missing root has no links to traverse; lexical containment
    // (proven above) is the strongest available claim.
    return;
  }
  const segments = path
    .relative(resolvedRoot, target)
    .split(path.sep)
    .filter((segment) => segment.length > 0);
  let lexical = resolvedRoot;
  for (const segment of segments) {
    lexical = path.join(lexical, segment);
    try {
      await lstat(lexical);
    } catch (error) {
      if (getErrnoCode(error) === "ENOENT") {
        return;
      }
      fail("Artifact path cannot be proven inside the upload root");
    }
    let realLevel: string;
    try {
      realLevel = await realpath(lexical);
    } catch {
      // Dangling link (or unreadable level): no trustworthy realpath,
      // so there is no containment proof — fail closed.
      fail("Artifact path cannot be proven inside the upload root");
    }
    const relative = path.relative(realRoot, realLevel as string);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("Artifact path escapes the upload root via symlink");
    }
  }
}

function getErrnoCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}
