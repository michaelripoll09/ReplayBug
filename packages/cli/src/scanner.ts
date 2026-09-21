/**
 * RS-07 upload scanner: `.map` files plus their associated generated
 * assets, with canonical POSIX artifact paths and symlink-escape guards.
 *
 * - The root is canonicalized (absolute + realpath) and walked
 *   recursively; entries sort by name at every level so output order is
 *   deterministic before the final artifact-path sort.
 * - Every discovered file proves containment via RS-06's
 *   `canonicalizeArtifactPath` + `assertNoSymlinkEscape` (reused, never
 *   reimplemented). Symlink escapes and dangling links are skipped with
 *   a clear warning — never followed, never uploaded.
 * - Symlinked directories are never descended into (cycle-safe); they
 *   are skipped with a warning.
 * - A generated asset (`.js`/`.mjs`/`.cjs`) is collected only when it is
 *   associated with a collected map: a sibling `<asset>.map` file, a
 *   map's safe `file`-property hint, or the asset's own
 *   `sourceMappingURL` comment pointing at a collected map. The asset is
 *   read as text ONLY for that lookup — never executed, never parsed as
 *   code. Remote (`http:`, `//`, `data:`) references are never fetched.
 * - Unrelated extensions are ignored silently.
 */
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  ArtifactPathError,
  assertNoSymlinkEscape,
  canonicalizeArtifactPath,
  hashFile,
} from "@replaybug/artifacts";
import { CliError } from "./errors.js";
import type { UploadArtifactType } from "./client.js";

export interface ScannedArtifact {
  /** Canonical POSIX relative path (server `artifactPath`). */
  artifactPath: string;
  artifactType: UploadArtifactType;
  /** Lexical absolute path on disk (containment already proven). */
  absolutePath: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 over the exact bytes. */
  contentHash: string;
}

export interface ScanResult {
  /** Realpath of the scanned root. */
  root: string;
  /** Deterministically ordered (by artifactPath) artifacts. */
  artifacts: ScannedArtifact[];
  /** Human warnings (symlink skips, rejected names). Printed to stderr. */
  warnings: string[];
}

interface Candidate {
  canonical: string;
  absolutePath: string;
  extension: string;
}

/** Bytes of an asset tail inspected for a sourceMappingURL comment. */
const SOURCE_MAPPING_URL_TAIL_BYTES = 4096;

const SOURCE_MAPPING_URL_PATTERN = /sourceMappingURL\s*=\s*([^\s'"`)\\]+)/g;

/**
 * Scan `rootInput` for source maps and their associated assets.
 * Throws `CliError` when the root is missing or not a directory.
 */
export async function scanSourcemapDirectory(
  rootInput: string,
): Promise<ScanResult> {
  const warnings: string[] = [];
  if (rootInput.trim() === "") {
    throw new CliError(
      "sourcemaps upload failed: the directory argument must not be empty.",
    );
  }
  const resolved = path.resolve(rootInput);
  let rootStat;
  try {
    rootStat = await stat(resolved);
  } catch {
    throw new CliError(
      `sourcemaps upload failed: directory "${rootInput}" does not exist.`,
      {
        hint: "Pass the build output directory that holds the .map files (for example ./dist).",
      },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new CliError(
      `sourcemaps upload failed: "${rootInput}" is not a directory.`,
      {
        hint: "Pass the build output directory that holds the .map files (for example ./dist).",
      },
    );
  }
  let root: string;
  try {
    root = await realpath(resolved);
  } catch {
    throw new CliError(
      `sourcemaps upload failed: directory "${rootInput}" cannot be resolved.`,
    );
  }

  const candidates = await collectCandidates(root, warnings);
  const maps = candidates.filter((candidate) => candidate.extension === ".map");
  const mapPaths = new Set(maps.map((candidate) => candidate.canonical));
  const hintedAssets = await collectFileHints(maps);

  const assets: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.extension === ".map") {
      continue;
    }
    if (mapPaths.has(`${candidate.canonical}.map`)) {
      assets.push(candidate);
      continue;
    }
    if (hintedAssets.has(candidate.canonical)) {
      assets.push(candidate);
      continue;
    }
    const referenced = await readSourceMappingTarget(candidate);
    if (referenced !== null && mapPaths.has(referenced)) {
      assets.push(candidate);
    }
  }

  const artifacts: ScannedArtifact[] = [];
  for (const candidate of [...maps, ...assets]) {
    const digest = await hashFile(candidate.absolutePath);
    artifacts.push({
      artifactPath: candidate.canonical,
      artifactType:
        candidate.extension === ".map" ? "source_map" : "minified_asset",
      absolutePath: candidate.absolutePath,
      sizeBytes: digest.sizeBytes,
      contentHash: digest.contentHash,
    });
  }
  artifacts.sort((a, b) => (a.artifactPath < b.artifactPath ? -1 : 1));
  return { root, artifacts, warnings };
}

async function collectCandidates(
  root: string,
  warnings: string[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const visitedDirs = new Set<string>();
  await walkDirectory(root, root, visitedDirs, candidates, warnings);
  return candidates;
}

async function walkDirectory(
  root: string,
  current: string,
  visitedDirs: Set<string>,
  candidates: Candidate[],
  warnings: string[],
): Promise<void> {
  let realCurrent: string;
  try {
    realCurrent = await realpath(current);
  } catch {
    warnings.push(
      `Skipping "${displayRelative(root, current)}": cannot resolve the directory.`,
    );
    return;
  }
  if (visitedDirs.has(realCurrent)) {
    warnings.push(
      `Skipping "${displayRelative(root, current)}": directory cycle detected.`,
    );
    return;
  }
  visitedDirs.add(realCurrent);

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    warnings.push(
      `Skipping "${displayRelative(root, current)}": cannot read the directory.`,
    );
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const lexical = path.join(current, entry.name);
    let entryStat;
    try {
      entryStat = await lstat(lexical);
    } catch {
      warnings.push(
        `Skipping "${displayRelative(root, lexical)}": cannot access the entry.`,
      );
      continue;
    }
    if (entryStat.isSymbolicLink()) {
      await handleSymlink(root, lexical, candidates, warnings);
      continue;
    }
    if (entryStat.isDirectory()) {
      await walkDirectory(root, lexical, visitedDirs, candidates, warnings);
      continue;
    }
    if (entryStat.isFile()) {
      await handleFile(root, lexical, warnings, candidates);
    }
  }
}

/**
 * Symlinks are never trusted blindly: dangling links and symlinked
 * directories are skipped with a warning, and symlinked files still
 * face the per-file containment proof in `handleFile`.
 */
async function handleSymlink(
  root: string,
  lexical: string,
  candidates: Candidate[],
  warnings: string[],
): Promise<void> {
  let targetStat;
  try {
    targetStat = await stat(lexical);
  } catch {
    warnings.push(
      `Skipping "${displayRelative(root, lexical)}": dangling symlink.`,
    );
    return;
  }
  if (targetStat.isDirectory()) {
    warnings.push(
      `Skipping symlinked directory "${displayRelative(root, lexical)}": directory symlinks are never followed.`,
    );
    return;
  }
  if (targetStat.isFile()) {
    await handleFile(root, lexical, warnings, candidates);
    return;
  }
  warnings.push(
    `Skipping "${displayRelative(root, lexical)}": not a regular file.`,
  );
}

async function handleFile(
  root: string,
  lexical: string,
  warnings: string[],
  candidates: Candidate[],
): Promise<void> {
  const relativePosix = path.relative(root, lexical).split(path.sep).join("/");
  let canonical: string;
  try {
    canonical = canonicalizeArtifactPath(relativePosix);
    await assertNoSymlinkEscape(root, canonical);
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      warnings.push(
        `Skipping "${relativePosix}": ${symlinkAwareReason(error)}.`,
      );
      return;
    }
    throw error;
  }
  const extension = extensionOf(canonical);
  if (extension !== ".map" && !isAssetExtension(extension)) {
    return;
  }
  candidates.push({ canonical, absolutePath: lexical, extension });
}

function symlinkAwareReason(error: ArtifactPathError): string {
  if (/symlink/i.test(error.message)) {
    return "the file escapes the upload directory via symlink";
  }
  return error.message;
}

function extensionOf(canonicalPath: string): string {
  const base = canonicalPath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

function isAssetExtension(extension: string): boolean {
  return extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

/**
 * Best-effort `file`-property hints from collected maps. A malformed map
 * yields no hint (never an error): the server remains the authoritative
 * validator and reports INVALID_SOURCE_MAP with the file name at upload.
 */
async function collectFileHints(maps: Candidate[]): Promise<Set<string>> {
  const hints = new Set<string>();
  for (const map of maps) {
    const hint = await readMapFileHint(map);
    if (hint !== null) {
      hints.add(hint);
    }
  }
  return hints;
}

async function readMapFileHint(map: Candidate): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(map.absolutePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const file = (parsed as Record<string, unknown>)["file"];
  if (typeof file !== "string" || file.trim() === "") {
    return null;
  }
  return resolveMapRelativeReference(map.canonical, file);
}

/**
 * Resolve a map-relative reference (a map `file` hint or an asset
 * `sourceMappingURL`) to a canonical artifact path, or null when it is
 * remote, absolute, escaping, or otherwise unsafe. Never fetches.
 */
function resolveMapRelativeReference(
  fromCanonical: string,
  reference: string,
): string | null {
  const trimmed = reference.trim();
  if (trimmed === "") {
    return null;
  }
  const withoutQuery = trimmed.split("?")[0]?.split("#")[0] ?? "";
  if (withoutQuery === "") {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutQuery)) {
    return null;
  }
  if (withoutQuery.startsWith("//")) {
    return null;
  }
  const fromDir = fromCanonical.includes("/")
    ? (fromCanonical.slice(0, fromCanonical.lastIndexOf("/")) as string)
    : "";
  const joined = path.posix.normalize(
    fromDir === "" ? `/${withoutQuery}` : `/${fromDir}/${withoutQuery}`,
  );
  if (joined === "/" || joined.startsWith("/../") || joined === "/..") {
    return null;
  }
  const candidate = joined.slice(1);
  try {
    return canonicalizeArtifactPath(candidate);
  } catch {
    return null;
  }
}

/**
 * Text-only `sourceMappingURL` lookup over the asset tail. Remote URLs
 * are recognized and ignored (never fetched); only references that
 * resolve to a path inside the upload root are returned.
 */
async function readSourceMappingTarget(
  asset: Candidate,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(asset.absolutePath, "r");
  } catch {
    return null;
  }
  try {
    const fileStat = await handle.stat();
    const tailSize = Math.min(fileStat.size, SOURCE_MAPPING_URL_TAIL_BYTES);
    if (tailSize <= 0) {
      return null;
    }
    const buffer = Buffer.alloc(tailSize);
    await handle.read(
      buffer,
      0,
      tailSize,
      Math.max(0, fileStat.size - tailSize),
    );
    const tail = buffer.toString("utf8");
    const matches = tail.match(SOURCE_MAPPING_URL_PATTERN);
    if (matches === null || matches.length === 0) {
      return null;
    }
    const last = matches[matches.length - 1] as string;
    const value = last.split("=")[1]?.trim() ?? "";
    if (value === "") {
      return null;
    }
    return resolveMapRelativeReference(asset.canonical, value);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function displayRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
