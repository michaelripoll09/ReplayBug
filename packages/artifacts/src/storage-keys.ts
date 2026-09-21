/**
 * Storage-key utilities (RS-05).
 *
 * Callers pass SERVER-GENERATED storage keys only — never user-provided
 * filesystem paths. The canonical layout is
 * `<project-id>/<release-id>/<content-hash>` where both ids are UUIDs and
 * the hash is a lowercase hex SHA-256. The user-facing `artifactPath`
 * (e.g. `assets/index-abc.js.map`) stays relational metadata in Postgres
 * and is NEVER a disk path, so traversal is impossible by design:
 * keys carry no `.`, `..`, slashes beyond separators, or platform
 * separators, and every key is re-validated plus containment-checked
 * against the root on each operation.
 */
import path from "node:path";
import { ArtifactKeyError } from "./errors.js";

export const STORAGE_KEY_MAX_LENGTH = 1024;
export const STORAGE_KEY_MAX_SEGMENTS = 8;
export const STORAGE_KEY_SEGMENT_MAX_LENGTH = 128;

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validate a storage key without touching the disk. Accepts 1..8
 * slash-separated segments of `[A-Za-z0-9_-]` (leading alnum). Rejects
 * empty input, absolute paths, drive/UNC shapes, backslashes, `.`/`..`,
 * empty segments, NUL/control characters, and over-long input. Returns
 * the key verbatim.
 */
export function validateStorageKey(input: unknown): string {
  if (typeof input !== "string") {
    throw new ArtifactKeyError(String(input), "Storage key must be a string");
  }
  if (input.length < 1 || input.length > STORAGE_KEY_MAX_LENGTH) {
    throw new ArtifactKeyError(
      input,
      `Storage key must be 1-${STORAGE_KEY_MAX_LENGTH} characters`,
    );
  }
  const segments = input.split("/");
  if (segments.length > STORAGE_KEY_MAX_SEGMENTS) {
    throw new ArtifactKeyError(
      input,
      `Storage key must have at most ${STORAGE_KEY_MAX_SEGMENTS} segments`,
    );
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > STORAGE_KEY_SEGMENT_MAX_LENGTH ||
      !SEGMENT_PATTERN.test(segment)
    ) {
      throw new ArtifactKeyError(input, "Storage key has an invalid segment");
    }
  }
  return input;
}

/**
 * Build the canonical `<project-id>/<release-id>/<content-hash>` key.
 * Inputs are validated (UUID / lowercase-hex-SHA-256) so only trusted
 * server-generated values can become disk addresses.
 */
export function buildArtifactStorageKey(
  projectId: unknown,
  releaseId: unknown,
  contentHash: unknown,
): string {
  if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) {
    throw new ArtifactKeyError(String(projectId), "Project id must be a UUID");
  }
  if (typeof releaseId !== "string" || !UUID_PATTERN.test(releaseId)) {
    throw new ArtifactKeyError(String(releaseId), "Release id must be a UUID");
  }
  if (
    typeof contentHash !== "string" ||
    !CONTENT_HASH_PATTERN.test(contentHash)
  ) {
    throw new ArtifactKeyError(
      String(contentHash),
      "Content hash must be 64 lowercase hex characters",
    );
  }
  return `${projectId}/${releaseId}/${contentHash}`;
}

export interface ParsedArtifactStorageKey {
  projectId: string;
  releaseId: string;
  contentHash: string;
}

/** Parse a canonical 3-segment key back into its server-generated parts. */
export function parseArtifactStorageKey(
  input: unknown,
): ParsedArtifactStorageKey {
  const key = validateStorageKey(input);
  const segments = key.split("/");
  if (segments.length !== 3) {
    throw new ArtifactKeyError(
      key,
      "Artifact storage key must have exactly 3 segments",
    );
  }
  const [projectId, releaseId, contentHash] = segments as [
    string,
    string,
    string,
  ];
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(releaseId)) {
    throw new ArtifactKeyError(key, "Artifact storage key ids must be UUIDs");
  }
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new ArtifactKeyError(
      key,
      "Artifact storage key hash must be 64 lowercase hex characters",
    );
  }
  return { projectId, releaseId, contentHash };
}

/**
 * Resolve a validated key to an absolute path and prove containment:
 * the result must stay strictly inside `root`. Throws ArtifactKeyError
 * for anything that would escape (defense in depth — validated keys
 * cannot contain traversal, but the check runs anyway).
 */
export function resolveStoragePath(root: string, key: string): string {
  const validKey = validateStorageKey(key);
  const resolved = path.resolve(root, ...validKey.split("/"));
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new ArtifactKeyError(key, "Storage key escapes the artifact root");
  }
  return resolved;
}
