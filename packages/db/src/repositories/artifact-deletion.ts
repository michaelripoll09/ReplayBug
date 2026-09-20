import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  ReleaseValidationError,
  validateContentHash,
  validateStorageKey,
} from "../releases.js";
import { artifactDeletionOutbox } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type ArtifactDeletionOutboxRow =
  typeof artifactDeletionOutbox.$inferSelect;

export interface PendingArtifactDeletionItem {
  id: string;
  projectId: string | null;
  storageKey: string;
  attemptCount: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
}

export interface InsertArtifactDeletionOutboxInput {
  projectId?: string | null;
  storageKey: unknown;
}

export interface ParsedArtifactDeletionStorageKey {
  key: string;
  projectId: string;
  releaseId: string;
  contentHash: string;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Validate the exact three-segment key shape used by artifact storage. */
export function parseArtifactDeletionStorageKey(
  input: unknown,
): ParsedArtifactDeletionStorageKey {
  const key = validateStorageKey(input);
  const segments = key.split("/");
  if (segments.length !== 3) {
    throw new ReleaseValidationError(
      "storageKey",
      "Artifact storage key must have exactly three segments",
    );
  }
  const [projectId, releaseId, contentHash] = segments as [
    string,
    string,
    string,
  ];
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(releaseId)) {
    throw new ReleaseValidationError(
      "storageKey",
      "Artifact storage key ids must be UUIDs",
    );
  }
  validateContentHash(contentHash);
  return { key, projectId, releaseId, contentHash };
}

export const MAX_ARTIFACT_DELETION_BATCH_SIZE = 100;
export const MAX_ARTIFACT_DELETION_ERROR_LENGTH = 2_000;

const pendingArtifactDeletionColumns = {
  id: artifactDeletionOutbox.id,
  projectId: artifactDeletionOutbox.projectId,
  storageKey: artifactDeletionOutbox.storageKey,
  attemptCount: artifactDeletionOutbox.attemptCount,
  createdAt: artifactDeletionOutbox.createdAt,
  lastAttemptAt: artifactDeletionOutbox.lastAttemptAt,
};

function boundedBatchSize(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_ARTIFACT_DELETION_BATCH_SIZE
  ) {
    throw new RangeError(
      `Artifact deletion batch size must be an integer between 1 and ${MAX_ARTIFACT_DELETION_BATCH_SIZE}`,
    );
  }
  return limit;
}

/**
 * Enqueue a trusted storage key idempotently. The unique storage-key guard
 * prevents duplicate filesystem work across project/workspace cascades.
 */
export async function insertArtifactDeletionOutbox(
  db: DbOrTx,
  input: InsertArtifactDeletionOutboxInput,
): Promise<ArtifactDeletionOutboxRow> {
  const storageKey = parseArtifactDeletionStorageKey(input.storageKey).key;
  const rows = await db
    .insert(artifactDeletionOutbox)
    .values({
      projectId: input.projectId ?? null,
      storageKey,
      attemptCount: 0,
      lastAttemptAt: null,
      completedAt: null,
      lastError: null,
    })
    .onConflictDoNothing({ target: artifactDeletionOutbox.storageKey })
    .returning();
  const inserted = rows[0];
  if (inserted !== undefined) {
    return inserted;
  }

  const existing = await findArtifactDeletionOutboxByStorageKey(db, storageKey);
  if (existing === undefined) {
    throw new Error("Failed to insert artifact deletion outbox row");
  }
  return existing;
}

export async function findArtifactDeletionOutboxByStorageKey(
  db: DbOrTx,
  storageKey: string,
): Promise<ArtifactDeletionOutboxRow | undefined> {
  const normalizedKey = parseArtifactDeletionStorageKey(storageKey).key;
  const rows = await db
    .select()
    .from(artifactDeletionOutbox)
    .where(eq(artifactDeletionOutbox.storageKey, normalizedKey))
    .limit(1);
  return rows[0];
}

/** Claim a bounded pending batch for one deletion worker transaction. */
export async function claimPendingArtifactDeletionBatch(
  tx: DbTransaction,
  limit: number,
): Promise<PendingArtifactDeletionItem[]> {
  return tx
    .select(pendingArtifactDeletionColumns)
    .from(artifactDeletionOutbox)
    .where(isNull(artifactDeletionOutbox.completedAt))
    .orderBy(
      asc(artifactDeletionOutbox.createdAt),
      asc(artifactDeletionOutbox.id),
    )
    .limit(boundedBatchSize(limit))
    .for("update", { skipLocked: true });
}

/** Mark filesystem removal complete; repeated calls remain harmless. */
export async function markArtifactDeletionCompleted(
  tx: DbTransaction,
  outboxId: string,
): Promise<ArtifactDeletionOutboxRow | undefined> {
  const rows = await tx
    .update(artifactDeletionOutbox)
    .set({
      completedAt: sql`now()`,
      lastAttemptAt: sql`now()`,
      lastError: null,
    })
    .where(
      and(
        eq(artifactDeletionOutbox.id, outboxId),
        isNull(artifactDeletionOutbox.completedAt),
      ),
    )
    .returning();
  return rows[0];
}

/** Keep worker diagnostics bounded and free of paths or secret material. */
export function sanitizeArtifactDeletionError(errorMessage: string): string {
  const compact = errorMessage.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(compact)
    ? compact
    : "artifact_deletion_failed";
}

/** Record a bounded worker error while keeping the row retryable. */
export async function recordArtifactDeletionFailure(
  tx: DbTransaction,
  outboxId: string,
  errorMessage: string,
): Promise<ArtifactDeletionOutboxRow | undefined> {
  const lastError = sanitizeArtifactDeletionError(errorMessage).slice(
    0,
    MAX_ARTIFACT_DELETION_ERROR_LENGTH,
  );
  const rows = await tx
    .update(artifactDeletionOutbox)
    .set({
      attemptCount: sql`${artifactDeletionOutbox.attemptCount} + 1`,
      lastAttemptAt: sql`now()`,
      lastError,
    })
    .where(
      and(
        eq(artifactDeletionOutbox.id, outboxId),
        isNull(artifactDeletionOutbox.completedAt),
      ),
    )
    .returning();
  return rows[0];
}
