/**
 * RS-04 release field validation (pure, synchronous, shape-only).
 *
 * These validators run before any repository insert so invalid versions,
 * SHAs and URLs fail fast with a typed error instead of leaking as raw
 * Postgres CHECK violations. Database CHECK constraints mirror the same
 * bounds as defense in depth. `validateRepositoryUrl` checks shape only —
 * it never fetches the URL (no SSRF surface).
 */

export class ReleaseValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ReleaseValidationError";
    this.field = field;
  }
}

export const RELEASE_VERSION_MAX_LENGTH = 128;
export const REPOSITORY_URL_MAX_LENGTH = 2048;
export const ARTIFACT_PATH_MAX_LENGTH = 1024;
export const STORAGE_KEY_MAX_LENGTH = 1024;

const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{7,64}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
 * Release version: 1..128 chars, no control chars, NOT semver-restricted.
 * `web@1.4.2`, `demo@2026.09.18` and `1.4.2` are all valid. The value is
 * returned verbatim — never trimmed — so uniqueness stays exact-match.
 */
export function validateReleaseVersion(input: unknown): string {
  if (typeof input !== "string") {
    throw new ReleaseValidationError("version", "Version must be a string");
  }
  if (input.length < 1 || input.length > RELEASE_VERSION_MAX_LENGTH) {
    throw new ReleaseValidationError(
      "version",
      `Version must be 1-${RELEASE_VERSION_MAX_LENGTH} characters`,
    );
  }
  if (hasControlChars(input)) {
    throw new ReleaseValidationError(
      "version",
      "Version contains invalid characters",
    );
  }
  return input;
}

/** Optional hex git SHA (7..64 chars); null/undefined map to null. */
export function validateCommitSha(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== "string" || !COMMIT_SHA_PATTERN.test(input)) {
    throw new ReleaseValidationError(
      "commitSha",
      "Commit SHA must be 7-64 hex characters",
    );
  }
  return input;
}

/**
 * Optional repository URL: http/https shape only, bounded to 2048 chars.
 * Never fetched — callers must not perform network I/O with this value.
 */
export function validateRepositoryUrl(input: unknown): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== "string") {
    throw new ReleaseValidationError(
      "repositoryUrl",
      "Repository URL must be a string",
    );
  }
  if (input.length < 1 || input.length > REPOSITORY_URL_MAX_LENGTH) {
    throw new ReleaseValidationError(
      "repositoryUrl",
      `Repository URL must be 1-${REPOSITORY_URL_MAX_LENGTH} characters`,
    );
  }
  if (hasControlChars(input)) {
    throw new ReleaseValidationError(
      "repositoryUrl",
      "Repository URL contains invalid characters",
    );
  }
  const rest =
    input.slice(0, 8) === "https://"
      ? input.slice("https://".length)
      : input.slice(0, 7) === "http://"
        ? input.slice("http://".length)
        : null;
  if (rest === null || rest.length === 0 || rest.includes(" ")) {
    throw new ReleaseValidationError(
      "repositoryUrl",
      "Repository URL must be an http(s) URL",
    );
  }
  return input;
}

/**
 * RS-04 minimal artifact path guard: non-empty, bounded, no NUL.
 * Full canonicalization and traversal rejection belong to RS-06.
 */
export function validateArtifactPath(input: unknown): string {
  if (typeof input !== "string") {
    throw new ReleaseValidationError(
      "artifactPath",
      "Artifact path must be a string",
    );
  }
  if (input.length < 1 || input.length > ARTIFACT_PATH_MAX_LENGTH) {
    throw new ReleaseValidationError(
      "artifactPath",
      `Artifact path must be 1-${ARTIFACT_PATH_MAX_LENGTH} characters`,
    );
  }
  if (input.includes(String.fromCharCode(0))) {
    throw new ReleaseValidationError(
      "artifactPath",
      "Artifact path contains invalid characters",
    );
  }
  return input;
}

/** SHA-256 content hash: exactly 64 lowercase hex chars. */
export function validateContentHash(input: unknown): string {
  if (typeof input !== "string" || !CONTENT_HASH_PATTERN.test(input)) {
    throw new ReleaseValidationError(
      "contentHash",
      "Content hash must be 64 lowercase hex characters",
    );
  }
  return input;
}

export const ARTIFACT_TYPES = ["source_map", "minified_asset"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function validateArtifactType(input: unknown): ArtifactType {
  if (input !== "source_map" && input !== "minified_asset") {
    throw new ReleaseValidationError(
      "artifactType",
      "Artifact type must be 'source_map' or 'minified_asset'",
    );
  }
  return input;
}

/** Non-negative integer byte size. */
export function validateSizeBytes(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0 ||
    !Number.isFinite(input)
  ) {
    throw new ReleaseValidationError(
      "sizeBytes",
      "Size must be a non-negative integer",
    );
  }
  return input;
}

/** Server-generated storage key: non-empty, bounded. */
export function validateStorageKey(input: unknown): string {
  if (typeof input !== "string") {
    throw new ReleaseValidationError(
      "storageKey",
      "Storage key must be a string",
    );
  }
  if (input.length < 1 || input.length > STORAGE_KEY_MAX_LENGTH) {
    throw new ReleaseValidationError(
      "storageKey",
      `Storage key must be 1-${STORAGE_KEY_MAX_LENGTH} characters`,
    );
  }
  return input;
}
