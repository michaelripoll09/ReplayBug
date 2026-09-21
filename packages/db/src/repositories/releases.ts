import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { events, releaseArtifacts, releases } from "../schema.js";
import {
  ReleaseValidationError,
  validateArtifactPath,
  validateArtifactType,
  validateCommitSha,
  validateContentHash,
  validateReleaseVersion,
  validateRepositoryUrl,
  validateSizeBytes,
  validateStorageKey,
  type ArtifactType,
} from "../releases.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type ReleaseRow = typeof releases.$inferSelect;
export type ReleaseArtifactRow = typeof releaseArtifacts.$inferSelect;

/**
 * Thrown when a release version already exists with different identity
 * metadata. Carries the stored row so callers can report the conflict
 * without a second lookup. Identity metadata is immutable: the stored row
 * is never silently updated.
 */
export class ReleaseVersionConflictError extends Error {
  readonly existing: ReleaseRow;

  constructor(existing: ReleaseRow) {
    super(`Release version '${existing.version}' already exists`);
    this.name = "ReleaseVersionConflictError";
    this.existing = existing;
  }
}

/** True for Postgres unique violations (code 23505), incl. Drizzle wrappers. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === "23505") {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export interface CreateReleaseInput {
  projectId: string;
  version: unknown;
  commitSha?: unknown;
  repositoryUrl?: unknown;
}

export interface CreateReleaseResult {
  row: ReleaseRow;
  /** False when the identical release already existed (idempotent hit). */
  created: boolean;
}

/**
 * RS-04 release create with idempotent semantics, always scoped to one
 * project. Same version + identical metadata returns the existing row
 * (`created: false`, never a duplicate). Same version + any metadata
 * difference throws `ReleaseVersionConflictError` and leaves the stored
 * row untouched. Validation failures throw `ReleaseValidationError`.
 */
export async function createRelease(
  db: DbOrTx,
  input: CreateReleaseInput,
): Promise<CreateReleaseResult> {
  const version = validateReleaseVersion(input.version);
  const commitSha = validateCommitSha(input.commitSha ?? null);
  const repositoryUrl = validateRepositoryUrl(input.repositoryUrl ?? null);

  try {
    const rows = await db
      .insert(releases)
      .values({
        projectId: input.projectId,
        version,
        commitSha,
        repositoryUrl,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to insert release");
    }
    return { row, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const existing = await findReleaseByProjectAndVersion(
      db,
      input.projectId,
      version,
    );
    if (existing === undefined) {
      throw error;
    }
    if (
      existing.commitSha !== commitSha ||
      existing.repositoryUrl !== repositoryUrl
    ) {
      throw new ReleaseVersionConflictError(existing);
    }
    return { row: existing, created: false };
  }
}

export async function findReleaseByProjectAndVersion(
  db: DbOrTx,
  projectId: string,
  version: string,
): Promise<ReleaseRow | undefined> {
  const rows = await db
    .select()
    .from(releases)
    .where(
      and(eq(releases.projectId, projectId), eq(releases.version, version)),
    )
    .limit(1);
  return rows[0];
}

export async function findReleaseByIdInProject(
  db: DbOrTx,
  projectId: string,
  id: string,
): Promise<ReleaseRow | undefined> {
  const rows = await db
    .select()
    .from(releases)
    .where(and(eq(releases.projectId, projectId), eq(releases.id, id)))
    .limit(1);
  return rows[0];
}

/**
 * Deterministic project-scoped list: created_at, then version, then id
 * (the id tiebreak keeps equal-timestamp rows stable).
 */
export async function listReleasesByProject(
  db: DbOrTx,
  projectId: string,
): Promise<ReleaseRow[]> {
  return db
    .select()
    .from(releases)
    .where(eq(releases.projectId, projectId))
    .orderBy(asc(releases.createdAt), asc(releases.version), asc(releases.id));
}

/** Lock all releases for the supplied projects in deterministic order. */
export async function lockReleasesByProjects(
  tx: DbTransaction,
  projectIds: readonly string[],
): Promise<ReleaseRow[]> {
  if (projectIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(releases)
    .where(inArray(releases.projectId, [...projectIds]))
    .orderBy(asc(releases.projectId), asc(releases.id))
    .for("update");
}

/** Lock all artifacts for the supplied releases in deterministic order. */
export async function lockArtifactsByReleases(
  tx: DbTransaction,
  releaseIds: readonly string[],
): Promise<ReleaseArtifactRow[]> {
  if (releaseIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(releaseArtifacts)
    .where(inArray(releaseArtifacts.releaseId, [...releaseIds]))
    .orderBy(
      asc(releaseArtifacts.releaseId),
      asc(releaseArtifacts.artifactPath),
      asc(releaseArtifacts.id),
    )
    .for("update");
}

export interface InsertReleaseArtifactInput {
  releaseId: string;
  artifactPath: unknown;
  storageKey: unknown;
  contentHash: unknown;
  sizeBytes: unknown;
  artifactType: unknown;
}

/**
 * RS-04 artifact primitive: validated insert only. Same-hash idempotent
 * upsert and different-hash conflict detection belong to RS-06; the unique
 * (release_id, artifact_path) constraint enforced here backs that logic.
 */
export async function insertReleaseArtifact(
  db: DbOrTx,
  input: InsertReleaseArtifactInput,
): Promise<ReleaseArtifactRow> {
  const artifactPath = validateArtifactPath(input.artifactPath);
  const storageKey = validateStorageKey(input.storageKey);
  const contentHash = validateContentHash(input.contentHash);
  const sizeBytes = validateSizeBytes(input.sizeBytes);
  const artifactType: ArtifactType = validateArtifactType(input.artifactType);
  const rows = await db
    .insert(releaseArtifacts)
    .values({
      releaseId: input.releaseId,
      artifactPath,
      storageKey,
      contentHash,
      sizeBytes,
      artifactType,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert release artifact");
  }
  return row;
}

export async function findArtifactByReleaseAndPath(
  db: DbOrTx,
  releaseId: string,
  artifactPath: string,
): Promise<ReleaseArtifactRow | undefined> {
  const rows = await db
    .select()
    .from(releaseArtifacts)
    .where(
      and(
        eq(releaseArtifacts.releaseId, releaseId),
        eq(releaseArtifacts.artifactPath, artifactPath),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Deterministic per-release artifact list ordered by path. */
export async function listArtifactsByRelease(
  db: DbOrTx,
  releaseId: string,
): Promise<ReleaseArtifactRow[]> {
  return db
    .select()
    .from(releaseArtifacts)
    .where(eq(releaseArtifacts.releaseId, releaseId))
    .orderBy(asc(releaseArtifacts.artifactPath));
}

/** Artifact counts keyed by release id (missing ids map to zero). */
export async function countArtifactsByReleaseIds(
  db: DbOrTx,
  releaseIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (releaseIds.length === 0) {
    return counts;
  }
  const rows = await db
    .select({
      releaseId: releaseArtifacts.releaseId,
      count: sql<number>`count(*)::int`,
    })
    .from(releaseArtifacts)
    .where(inArray(releaseArtifacts.releaseId, releaseIds))
    .groupBy(releaseArtifacts.releaseId);
  for (const row of rows) {
    counts.set(row.releaseId, row.count);
  }
  return counts;
}

export interface ReleaseArtifactTypeCounts {
  total: number;
  sourceMap: number;
  minifiedAsset: number;
}

function emptyTypeCounts(): ReleaseArtifactTypeCounts {
  return { total: 0, sourceMap: 0, minifiedAsset: 0 };
}

/**
 * RS-10 per-type artifact counts keyed by release id. Missing ids map to
 * zero counts so dashboard rows never render `undefined`. Counts only —
 * storage keys and hashes never leave this query shape.
 */
export async function countArtifactsByReleaseIdsByType(
  db: DbOrTx,
  releaseIds: string[],
): Promise<Map<string, ReleaseArtifactTypeCounts>> {
  const counts = new Map<string, ReleaseArtifactTypeCounts>();
  if (releaseIds.length === 0) {
    return counts;
  }
  const rows = await db
    .select({
      releaseId: releaseArtifacts.releaseId,
      artifactType: releaseArtifacts.artifactType,
      count: sql<number>`count(*)::int`,
    })
    .from(releaseArtifacts)
    .where(inArray(releaseArtifacts.releaseId, releaseIds))
    .groupBy(releaseArtifacts.releaseId, releaseArtifacts.artifactType);
  for (const row of rows) {
    const entry = counts.get(row.releaseId) ?? emptyTypeCounts();
    entry.total += row.count;
    if (row.artifactType === "source_map") {
      entry.sourceMap += row.count;
    } else if (row.artifactType === "minified_asset") {
      entry.minifiedAsset += row.count;
    }
    counts.set(row.releaseId, entry);
  }
  return counts;
}

/**
 * RS-10 occurrence counts: stored events per release version string within
 * one project. Versions are exact-match (`events.release` is free text);
 * unlisted versions map to zero.
 */
export async function countEventsByProjectAndReleaseVersions(
  db: DbOrTx,
  projectId: string,
  versions: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique = [...new Set(versions)];
  if (unique.length === 0) {
    return counts;
  }
  const rows = await db
    .select({
      release: events.release,
      count: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(
      and(eq(events.projectId, projectId), inArray(events.release, unique)),
    )
    .groupBy(events.release);
  for (const row of rows) {
    if (row.release !== null) {
      counts.set(row.release, row.count);
    }
  }
  return counts;
}

export { ReleaseValidationError };
