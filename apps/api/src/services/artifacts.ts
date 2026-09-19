import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactPathError,
  InvalidArtifactTypeError,
  InvalidSourceMapError,
  PREFLIGHT_MAX_ENTRIES,
  UPLOAD_AGGREGATE_MAX_BYTES,
  artifactTypeForExtension,
  assertSafeAssetContent,
  buildArtifactStorageKey,
  canonicalizeArtifactPath,
  validateArtifactExtension,
  validateArtifactMimeType,
  validateSourceMapBytes,
  ArtifactStorageError,
  ArtifactTooLargeError,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import {
  ReleaseRepo,
  ReleaseValidationError,
  validateArtifactType,
  validateContentHash,
  validateReleaseVersion,
  validateSizeBytes,
  type ArtifactType,
  type Database,
  type DbOrTx,
  type ReleaseArtifactRow,
} from "@replaybug/db";
import {
  artifactPathConflict,
  artifactPathInvalid,
  artifactStorageUnavailable,
  artifactTooLarge,
  internalError,
  invalidArtifactType,
  invalidSourceMap,
  isUniqueViolation,
  notFound,
  validationError,
} from "../errors.js";
import type { CliPrincipal } from "../auth/cli-auth.js";

/**
 * RS-06 artifact upload pipeline (preflight + multipart upload).
 *
 * Trust rules: the release comes from the URL, the project from the
 * bearer token — never from the body. Client hashes are never trusted:
 * the server streams every upload to a temp file while computing
 * SHA-256 + size, validates content (Source Map v3 for `.map`,
 * executable/markup sniffing for assets), then compares against the
 * stored row (same hash → idempotent existing, different hash →
 * 409 ARTIFACT_PATH_CONFLICT, no overwrite).
 *
 * Compensation: the staged temp dir is removed on success,
 * validation failure, abort, storage failure and unexpected errors;
 * a file written to trusted storage is deleted when the DB insert
 * fails, so outages never leave orphaned blobs or rows.
 */

export interface ArtifactReleaseRef {
  id: string;
  projectId: string;
}

export interface ArtifactRecord {
  id: string;
  releaseId: string;
  artifactPath: string;
  storageKey: string;
  contentHash: string;
  sizeBytes: number;
  artifactType: ArtifactType;
  createdAt: Date;
}

export interface NewArtifactRecord {
  releaseId: string;
  artifactPath: string;
  storageKey: string;
  contentHash: string;
  sizeBytes: number;
  artifactType: ArtifactType;
}

export interface ArtifactDto {
  id: string;
  artifactPath: string;
  artifactType: ArtifactType;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Record-store port: the service depends on this interface (not on
 * Drizzle) so compensation is unit-testable with fakes against real
 * storage. Routes inject `drizzleArtifactRecordStore(db)`.
 */
export interface ArtifactRecordStore {
  findByPath(
    releaseId: string,
    artifactPath: string,
  ): Promise<ArtifactRecord | undefined>;
  insert(record: NewArtifactRecord): Promise<ArtifactRecord>;
}

function toRecord(row: ReleaseArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    releaseId: row.releaseId,
    artifactPath: row.artifactPath,
    storageKey: row.storageKey,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    artifactType: row.artifactType as ArtifactType,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

export function toArtifactDto(record: ArtifactRecord): ArtifactDto {
  return {
    id: record.id,
    artifactPath: record.artifactPath,
    artifactType: record.artifactType,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
  };
}

/** Drizzle-backed store for route wiring (real PG). */
export function drizzleArtifactRecordStore(db: DbOrTx): ArtifactRecordStore {
  return {
    findByPath: async (releaseId, artifactPath) => {
      const row = await ReleaseRepo.findArtifactByReleaseAndPath(
        db,
        releaseId,
        artifactPath,
      );
      return row === undefined ? undefined : toRecord(row);
    },
    insert: async (record) =>
      toRecord(await ReleaseRepo.insertReleaseArtifact(db, record)),
  };
}

/** Resolve the caller's release from the URL version (project-scoped). */
export async function findCliReleaseOrThrow(
  db: Database,
  principal: CliPrincipal,
  versionParam: unknown,
): Promise<ArtifactReleaseRef> {
  let version: string;
  try {
    version = validateReleaseVersion(versionParam);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(error.message);
    }
    throw error;
  }
  const release = await ReleaseRepo.findReleaseByProjectAndVersion(
    db,
    principal.projectId,
    version,
  );
  if (release === undefined) {
    throw notFound("Release");
  }
  return { id: release.id, projectId: release.projectId };
}

export type PreflightVerdict = "upload" | "exists" | "conflict";

export interface PreflightEntryResult {
  artifactPath: string;
  artifactType: ArtifactType;
  contentHash: string;
  sizeBytes: number;
  verdict: PreflightVerdict;
}

export interface PreflightLimits {
  maxFileBytes: number;
  maxEntries?: number | undefined;
  aggregateMaxBytes?: number | undefined;
}

interface ValidatedPreflightEntry {
  artifactPath: string;
  artifactType: ArtifactType;
  contentHash: string;
  sizeBytes: number;
}

/**
 * Preflight check: bounded manifest (cap ~500 entries, ~250 MiB
 * aggregate) of `{artifactPath, artifactType, contentHash, sizeBytes}`
 * validated entry-by-entry (path canonicalization, extension/type
 * consistency, hash shape, per-file cap) and answered per artifact.
 * The server revalidates everything again at upload — verdicts are
 * advisory, never trusted.
 */
export async function checkArtifactPreflight(
  store: ArtifactRecordStore,
  releaseId: string,
  input: unknown,
  limits: PreflightLimits,
): Promise<PreflightEntryResult[]> {
  const maxEntries = limits.maxEntries ?? PREFLIGHT_MAX_ENTRIES;
  const aggregateMaxBytes =
    limits.aggregateMaxBytes ?? UPLOAD_AGGREGATE_MAX_BYTES;
  const entries = extractPreflightEntries(input, maxEntries);
  const validated = entries.map((entry, index) =>
    validatePreflightEntry(entry, index, limits.maxFileBytes),
  );
  const seen = new Set<string>();
  for (const entry of validated) {
    if (seen.has(entry.artifactPath)) {
      throw validationError(
        `Duplicate artifact path in manifest: "${entry.artifactPath}"`,
      );
    }
    seen.add(entry.artifactPath);
  }
  const aggregate = validated.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (aggregate > aggregateMaxBytes) {
    throw artifactTooLarge(
      `Preflight manifest declares ${aggregate} bytes, above the ${aggregateMaxBytes}-byte aggregate cap`,
    );
  }
  const results: PreflightEntryResult[] = [];
  for (const entry of validated) {
    const existing = await store.findByPath(releaseId, entry.artifactPath);
    const verdict: PreflightVerdict =
      existing === undefined
        ? "upload"
        : existing.contentHash === entry.contentHash
          ? "exists"
          : "conflict";
    results.push({ ...entry, verdict });
  }
  return results;
}

function extractPreflightEntries(
  input: unknown,
  maxEntries: number,
): unknown[] {
  if (typeof input !== "object" || input === null) {
    throw validationError("Preflight body must be an object");
  }
  const entries = (input as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(entries)) {
    throw validationError("Preflight body must contain an artifacts array");
  }
  if (entries.length < 1 || entries.length > maxEntries) {
    throw validationError(
      `Preflight manifest must contain 1-${maxEntries} entries`,
    );
  }
  return entries;
}

function validatePreflightEntry(
  entry: unknown,
  index: number,
  maxFileBytes: number,
): ValidatedPreflightEntry {
  if (typeof entry !== "object" || entry === null) {
    throw validationError(`Preflight entry ${index} must be an object`);
  }
  const candidate = entry as {
    artifactPath?: unknown;
    artifactType?: unknown;
    contentHash?: unknown;
    sizeBytes?: unknown;
  };
  let artifactPath: string;
  try {
    artifactPath = canonicalizeArtifactPath(candidate.artifactPath);
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw artifactPathInvalid(
        `Preflight entry ${index} has an invalid artifact path`,
      );
    }
    throw error;
  }
  const artifactType = validateEntryArtifactType(
    candidate.artifactType,
    artifactPath,
    index,
  );
  let contentHash: string;
  try {
    contentHash = validateContentHash(candidate.contentHash);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(`Preflight entry ${index}: ${error.message}`);
    }
    throw error;
  }
  let sizeBytes: number;
  try {
    sizeBytes = validateSizeBytes(candidate.sizeBytes);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(`Preflight entry ${index}: ${error.message}`);
    }
    throw error;
  }
  if (sizeBytes > maxFileBytes) {
    throw validationError(
      `Preflight entry ${index} declares ${sizeBytes} bytes, above the ${maxFileBytes}-byte per-file cap`,
    );
  }
  return { artifactPath, artifactType, contentHash, sizeBytes };
}

function validateEntryArtifactType(
  artifactType: unknown,
  canonicalPath: string,
  index: number,
): ArtifactType {
  let declared: ArtifactType;
  try {
    declared = validateArtifactType(artifactType);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(`Preflight entry ${index}: ${error.message}`);
    }
    throw error;
  }
  let expected: ArtifactType;
  try {
    expected = artifactTypeForExtension(
      validateArtifactExtension(canonicalPath),
    );
  } catch (error) {
    if (error instanceof InvalidArtifactTypeError) {
      throw invalidArtifactType(`Preflight entry ${index}: ${error.message}`);
    }
    throw error;
  }
  if (declared !== expected) {
    throw invalidArtifactType(
      `Preflight entry ${index} declares type "${declared}" for a "${expected}" path`,
    );
  }
  return declared;
}

export interface UploadArtifactInput {
  artifactPath: unknown;
  artifactType: unknown;
  mimeType?: unknown;
  source: AsyncIterable<Uint8Array>;
  signal?: AbortSignal | undefined;
}

export interface UploadPolicy {
  maxFileBytes: number;
  stagingDir?: string | undefined;
}

export interface UploadArtifactResult {
  record: ArtifactRecord;
  created: boolean;
}

export interface StagedRawUpload {
  dir: string;
  file: string;
  contentHash: string;
  sizeBytes: number;
}

export interface RawUploadPolicy {
  maxFileBytes: number;
  stagingDir?: string | undefined;
}

export interface FinalizeUploadMetadata {
  artifactPath: unknown;
  artifactType: unknown;
  mimeType?: unknown;
}

/**
 * Multipart upload: authenticate (route) → validate metadata/path/type →
 * stream to temp (server-side SHA-256 + size, capped BEFORE unbounded
 * buffering) → validate content → compare with the stored row → persist
 * to trusted storage → insert metadata. Temp is cleaned on every
 * outcome; storage writes are compensated when the DB insert fails.
 *
 * Multipart note: field order on the wire is not guaranteed, so routes
 * stage the file inline while collecting fields (`stageRawUpload`),
 * then gate persistence on metadata/content validation
 * (`finalizeArtifactUpload`). Staging is bounded by the same caps and
 * its temp is removed when validation fails — nothing invalid persists.
 */
export async function uploadReleaseArtifact(
  store: ArtifactRecordStore,
  storage: ArtifactStorage,
  release: ArtifactReleaseRef,
  input: UploadArtifactInput,
  policy: UploadPolicy,
): Promise<UploadArtifactResult> {
  assertSanePolicy(policy);
  assertNotAborted(input.signal);
  const staged = await stageRawUpload(input.source, policy, input.signal);
  return finalizeArtifactUpload(
    store,
    storage,
    release,
    staged,
    {
      artifactPath: input.artifactPath,
      artifactType: input.artifactType,
      mimeType: input.mimeType,
    },
    policy,
  );
}

function assertSanePolicy(policy: UploadPolicy | RawUploadPolicy): void {
  if (!Number.isInteger(policy.maxFileBytes) || policy.maxFileBytes <= 0) {
    throw internalError("Invalid artifact size policy");
  }
}

function canonicalizeUploadPath(artifactPath: unknown): string {
  try {
    return canonicalizeArtifactPath(artifactPath);
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      throw artifactPathInvalid(error.message);
    }
    throw error;
  }
}

function validateUploadType(
  artifactType: unknown,
  canonical: string,
): ArtifactType {
  let declared: ArtifactType;
  try {
    declared = validateArtifactType(artifactType);
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(error.message);
    }
    throw error;
  }
  let expected: ArtifactType;
  try {
    const extension = validateArtifactExtension(canonical);
    expected = artifactTypeForExtension(extension);
  } catch (error) {
    if (error instanceof InvalidArtifactTypeError) {
      throw invalidArtifactType(error.message);
    }
    throw error;
  }
  if (declared !== expected) {
    throw invalidArtifactType(
      `Declared type "${declared}" does not match path type "${expected}"`,
    );
  }
  return declared;
}

function validateUploadMime(mimeType: unknown): void {
  try {
    validateArtifactMimeType(mimeType, "");
  } catch (error) {
    if (error instanceof InvalidArtifactTypeError) {
      throw invalidArtifactType(error.message);
    }
    throw error;
  }
}

function validateUploadContent(bytes: Buffer, canonical: string): void {
  if (canonical.toLowerCase().endsWith(".map")) {
    try {
      validateSourceMapBytes(bytes);
    } catch (error) {
      if (error instanceof InvalidSourceMapError) {
        throw invalidSourceMap(error.message);
      }
      throw error;
    }
    return;
  }
  try {
    assertSafeAssetContent(bytes);
  } catch (error) {
    if (error instanceof InvalidArtifactTypeError) {
      throw invalidArtifactType(error.message);
    }
    throw error;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw internalError("Artifact upload aborted by client disconnect");
  }
}

/**
 * Stream an upload to a uniquely-named temp file while computing
 * SHA-256 + size inline. The per-file cap is enforced DURING the write
 * (before unbounded buffering); over-limit and aborted streams remove
 * the temp dir before throwing. Callers own the returned dir and must
 * remove it (finalize does so on every outcome).
 */
export async function stageRawUpload(
  source: AsyncIterable<Uint8Array>,
  policy: RawUploadPolicy,
  signal?: AbortSignal | undefined,
): Promise<StagedRawUpload> {
  assertSanePolicy(policy);
  const dir = await mkdtemp(
    join(policy.stagingDir ?? tmpdir(), "replaybug-upload-"),
  );
  const file = join(dir, `upload-${randomUUID()}.part`);
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const hasher = createHash("sha256");
  let sizeBytes = 0;
  try {
    assertNotAborted(signal);
    handle = await open(file, "wx");
    for await (const chunk of source) {
      assertNotAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > policy.maxFileBytes) {
        throw artifactTooLarge(
          `Artifact exceeds the ${policy.maxFileBytes}-byte per-file cap`,
        );
      }
      hasher.update(buffer);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesWritten } = await handle.write(
          buffer,
          offset,
          buffer.byteLength - offset,
        );
        if (bytesWritten <= 0) {
          throw internalError("Failed to stage artifact upload");
        }
        offset += bytesWritten;
      }
    }
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    await cleanup();
    throw error;
  }
  if (handle !== null) {
    await handle.close().catch(() => undefined);
  }
  return { dir, file, contentHash: hasher.digest("hex"), sizeBytes };
}

/**
 * Gate a staged upload on metadata/content validation, then persist:
 * canonicalize path → check declared type → MIME → server-side content
 * validation → idempotency/conflict against the stored row → trusted
 * storage key → atomic persist → metadata insert (compensating the
 * storage write on DB failure). The staged dir is removed on every
 * outcome. The client hash is never an input — the server hash wins.
 */
export async function finalizeArtifactUpload(
  store: ArtifactRecordStore,
  storage: ArtifactStorage,
  release: ArtifactReleaseRef,
  staged: StagedRawUpload,
  metadata: FinalizeUploadMetadata,
  policy: RawUploadPolicy,
): Promise<UploadArtifactResult> {
  try {
    const canonical = canonicalizeUploadPath(metadata.artifactPath);
    const artifactType = validateUploadType(metadata.artifactType, canonical);
    validateUploadMime(metadata.mimeType);
    const bytes = await readFile(staged.file);
    if (bytes.byteLength > policy.maxFileBytes) {
      throw artifactTooLarge(
        `Artifact exceeds the ${policy.maxFileBytes}-byte per-file cap`,
      );
    }
    validateUploadContent(bytes, canonical);
    const contentHash = hashBytes(bytes);
    const sizeBytes = bytes.byteLength;

    const existing = await store.findByPath(release.id, canonical);
    if (existing !== undefined) {
      if (existing.contentHash === contentHash) {
        return { record: existing, created: false };
      }
      throw artifactPathConflict();
    }

    const storageKey = buildArtifactStorageKey(
      release.projectId,
      release.id,
      contentHash,
    );
    await putToStorage(storage, storageKey, staged.file);
    try {
      const record = await store.insert({
        releaseId: release.id,
        artifactPath: canonical,
        storageKey,
        contentHash,
        sizeBytes,
        artifactType,
      });
      return { record, created: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return await resolveInsertRace(
          store,
          storage,
          release.id,
          canonical,
          storageKey,
          contentHash,
          error,
        );
      }
      // DB failure after a storage write: delete the new file so no
      // orphaned blob survives without its metadata row.
      await storage.delete(storageKey).catch(() => false);
      throw error;
    }
  } finally {
    await rm(staged.dir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function putToStorage(
  storage: ArtifactStorage,
  storageKey: string,
  stagedFile: string,
): Promise<void> {
  try {
    await storage.put(storageKey, createReadStream(stagedFile));
  } catch (error) {
    if (error instanceof ArtifactTooLargeError) {
      throw artifactTooLarge(
        `Artifact exceeds the ${error.maxBytes}-byte per-file cap`,
      );
    }
    if (error instanceof ArtifactStorageError) {
      throw artifactStorageUnavailable();
    }
    throw error;
  }
}

/**
 * A concurrent upload won the (release, path) race between our
 * existence check and insert. Same hash → idempotent hit (identical
 * bytes already live at the content-addressed key); different hash →
 * remove our orphaned write and report the conflict.
 */
async function resolveInsertRace(
  store: ArtifactRecordStore,
  storage: ArtifactStorage,
  releaseId: string,
  canonical: string,
  storageKey: string,
  contentHash: string,
  originalError: unknown,
): Promise<UploadArtifactResult> {
  const existing = await store.findByPath(releaseId, canonical);
  if (existing === undefined) {
    throw originalError;
  }
  if (existing.contentHash === contentHash) {
    return { record: existing, created: false };
  }
  await storage.delete(storageKey).catch(() => false);
  throw artifactPathConflict();
}
