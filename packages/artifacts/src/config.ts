/**
 * Shared artifact-storage configuration (RS-05).
 *
 * One env contract for both API and worker so they can point at the same
 * directory: `REPLAYBUG_ARTIFACT_DIR`. Docker volume wiring itself is
 * RS-13; the production container path is `/var/lib/replaybug/artifacts`.
 *
 * `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES` (default 25 MiB) is parsed here so
 * both services share the value, but it is NOT enforced by this package:
 * enforcement belongs to the RS-06 upload pipeline. Streaming writes in
 * `LocalArtifactStorage` accept any size.
 */
import os from "node:os";
import path from "node:path";
import { ArtifactConfigError } from "./errors.js";

export const ARTIFACT_DIR_ENV_VAR = "REPLAYBUG_ARTIFACT_DIR";
export const ARTIFACT_MAX_FILE_BYTES_ENV_VAR =
  "REPLAYBUG_ARTIFACT_MAX_FILE_BYTES";

/** Default per-file cap concept for RS-06 (25 MiB). */
export const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Sanity ceiling for explicit caps (1024 MiB) to catch unit typos. */
const MAX_FILE_BYTES_CEILING = 1024 * 1024 * 1024;

/** Source-tree container segments a root must never sit inside. */
const UNSAFE_PARENT_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "packages",
  "apps",
]);

/** Directory names that are never valid as the artifact root itself. */
const UNSAFE_ROOT_BASENAMES = new Set([
  "node_modules",
  ".git",
  "packages",
  "apps",
  "public",
  "src",
  "uploads",
]);

export interface ArtifactConfig {
  /** Resolved absolute artifact root (shared by API and worker). */
  dir: string;
  /**
   * Parsed per-file cap for the RS-06 upload pipeline. Documented here
   * for the shared env contract; this storage package does not enforce it.
   */
  maxFileBytes: number;
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
 * OS-local dev default OUTSIDE the repo source tree:
 * `~/.replaybug/artifacts` (cross-platform via `os.homedir()`).
 */
export function defaultArtifactDir(): string {
  return path.join(os.homedir(), ".replaybug", "artifacts");
}

/**
 * True when `candidate` is acceptable as an artifact root: absolute,
 * free of NUL/control characters, not a filesystem root or the home
 * directory itself, and outside well-known source-tree containers
 * (`packages/`, `apps/`, `node_modules/`, `.git/`) and classic web
 * roots (`public/`, `src/`, `uploads/`).
 */
export function isSafeArtifactRoot(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return false;
  }
  if (candidate.includes("\0") || hasControlChars(candidate)) {
    return false;
  }
  if (!path.isAbsolute(candidate)) {
    return false;
  }
  const resolved = path.resolve(candidate);
  if (path.parse(resolved).root === resolved) {
    return false;
  }
  if (resolved === path.resolve(os.homedir())) {
    return false;
  }
  const segments = resolved.split(path.sep).filter((s) => s.length > 0);
  const basename = segments[segments.length - 1];
  if (basename === undefined) {
    return false;
  }
  if (UNSAFE_ROOT_BASENAMES.has(basename.toLowerCase())) {
    return false;
  }
  for (const segment of segments.slice(0, -1)) {
    if (UNSAFE_PARENT_SEGMENTS.has(segment.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/** Assert safety and return the resolved absolute path. */
export function assertSafeArtifactRoot(dir: string): string {
  if (!isSafeArtifactRoot(dir)) {
    throw new ArtifactConfigError(
      `Refusing unsafe artifact root (must be an absolute path outside repo source trees, not a filesystem root, home dir, public/, src/, uploads/, packages/ or apps/): ${describeRoot(dir)}`,
    );
  }
  return path.resolve(dir);
}

function describeRoot(dir: string): string {
  // Paths are operator configuration, not secrets, so echoing the value
  // back in the error is safe and helps diagnose misconfiguration.
  return typeof dir === "string" && dir.length > 0 ? `"${dir}"` : "(empty)";
}

/**
 * Resolution order: explicit `REPLAYBUG_ARTIFACT_DIR` (validated) →
 * OS-local default. A set-but-blank variable fails fast instead of
 * silently falling back, so misconfiguration surfaces at startup.
 */
export function resolveArtifactDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env[ARTIFACT_DIR_ENV_VAR];
  if (explicit !== undefined) {
    if (explicit.trim() === "") {
      throw new ArtifactConfigError(
        `${ARTIFACT_DIR_ENV_VAR} is set but empty; unset it or point it at an absolute directory outside the repo source tree`,
      );
    }
    return assertSafeArtifactRoot(explicit);
  }
  return assertSafeArtifactRoot(defaultArtifactDir());
}

/**
 * Parse `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES` (positive integer bytes,
 * default 25 MiB). Parsed here for the shared API/worker env contract;
 * enforced by the RS-06 upload pipeline, NOT by storage writes.
 */
export function parseArtifactMaxFileBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ARTIFACT_MAX_FILE_BYTES_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ARTIFACT_MAX_FILE_BYTES;
  }
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_FILE_BYTES_CEILING
  ) {
    throw new ArtifactConfigError(
      `${ARTIFACT_MAX_FILE_BYTES_ENV_VAR} must be a positive integer of bytes (1-${MAX_FILE_BYTES_CEILING})`,
    );
  }
  return parsed;
}

/** Load the full shared env contract (single entry point for API/worker). */
export function loadArtifactConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactConfig {
  return {
    dir: resolveArtifactDir(env),
    maxFileBytes: parseArtifactMaxFileBytes(env),
  };
}
