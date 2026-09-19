import { and, asc, desc, eq, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  issueActivity,
  reproductionGenerationOutbox,
  reproductionTests,
} from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type ReproductionRow = typeof reproductionTests.$inferSelect;
export type ReproductionOutboxRow =
  typeof reproductionGenerationOutbox.$inferSelect;

export const REPRODUCTION_STATUSES = ["pending", "ready", "failed"] as const;
export type ReproductionStatus = (typeof REPRODUCTION_STATUSES)[number];

export const REPRODUCTION_ERROR_CODES = [
  "REPRODUCTION_BASE_URL_REQUIRED",
  "REPRODUCTION_UNSUPPORTED_FAILURE",
  "REPRODUCTION_OUTPUT_TOO_LARGE",
  "REPRODUCTION_INVALID_EVIDENCE",
  "REPRODUCTION_FAILED",
] as const;
export type ReproductionErrorCode = (typeof REPRODUCTION_ERROR_CODES)[number];

export interface CreatePendingReproductionInput {
  issueId: string;
  eventId: string | null;
  generatedByUserId: string | null;
  generatorVersion: string;
  language?: string;
  framework?: string;
  idempotencyKeyHash?: string | null;
}

/**
 * Inserts a pending reproduction row. Callers insert the generation outbox
 * row in the same transaction via `insertReproductionOutbox`.
 */
export async function insertPendingReproduction(
  tx: DbTransaction,
  input: CreatePendingReproductionInput,
): Promise<ReproductionRow> {
  const rows = await tx
    .insert(reproductionTests)
    .values({
      issueId: input.issueId,
      eventId: input.eventId,
      generatedByUserId: input.generatedByUserId,
      language: input.language ?? "typescript",
      framework: input.framework ?? "playwright",
      code: null,
      hasRedactedSteps: false,
      generatorVersion: input.generatorVersion,
      status: "pending",
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      idempotencyKeyHash: input.idempotencyKeyHash ?? null,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert pending reproduction");
  }
  return row;
}

/** Reads one reproduction by id (no lock). */
export async function findReproductionById(
  db: DbOrTx,
  reproductionId: string,
): Promise<ReproductionRow | undefined> {
  const rows = await db
    .select()
    .from(reproductionTests)
    .where(eq(reproductionTests.id, reproductionId))
    .limit(1);
  return rows[0];
}

/**
 * Locks one reproduction row for generation. Callers must be inside a
 * transaction: the row lock serializes concurrent generation completions
 * (retried jobs) of one reproduction.
 */
export async function lockReproductionById(
  tx: DbTransaction,
  reproductionId: string,
): Promise<ReproductionRow | undefined> {
  const rows = await tx
    .select()
    .from(reproductionTests)
    .where(eq(reproductionTests.id, reproductionId))
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Finds one reproduction by its idempotency hash. Deterministic oldest-first
 * when the hash was reused; NULL hashes never match (callers pass a concrete
 * hash, never NULL).
 */
export async function findReproductionByIdempotency(
  db: DbOrTx,
  idempotencyKeyHash: string,
): Promise<ReproductionRow | undefined> {
  const rows = await db
    .select()
    .from(reproductionTests)
    .where(eq(reproductionTests.idempotencyKeyHash, idempotencyKeyHash))
    .orderBy(asc(reproductionTests.createdAt), asc(reproductionTests.id))
    .limit(1);
  return rows[0];
}

export interface ReproductionCursor {
  createdAt: string;
  id: string;
}

export interface ListIssueReproductionsInput {
  issueId: string;
  limit: number;
  cursor?: ReproductionCursor;
}

export interface ListIssueReproductionsResult {
  rows: ReproductionRow[];
  nextCursor: string | null;
}

const REPRODUCTION_CURSOR_VERSION = 1;

/** Opaque cursor over (created_at DESC, id ASC) — newest first. */
export function encodeReproductionCursor(
  createdAt: string,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: REPRODUCTION_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeReproductionCursor(
  raw: string,
): ReproductionCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== REPRODUCTION_CURSOR_VERSION ||
      typeof record["createdAt"] !== "string" ||
      Number.isNaN(Date.parse(record["createdAt"])) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { createdAt: record["createdAt"], id: record["id"] };
  } catch {
    return null;
  }
}

/**
 * Issue reproductions newest-first with stable keyset pagination. Served by
 * `reproduction_tests_issue_created_idx`.
 */
export async function listIssueReproductions(
  db: DbOrTx,
  input: ListIssueReproductionsInput,
): Promise<ListIssueReproductionsResult> {
  const conditions: SQL[] = [eq(reproductionTests.issueId, input.issueId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${reproductionTests.createdAt} < ${input.cursor.createdAt}
      OR (${reproductionTests.createdAt} = ${input.cursor.createdAt}
          AND ${reproductionTests.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(reproductionTests)
    .where(and(...conditions))
    .orderBy(desc(reproductionTests.createdAt), asc(reproductionTests.id))
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const created =
        last.createdAt instanceof Date
          ? last.createdAt.toISOString()
          : new Date(last.createdAt).toISOString();
      nextCursor = encodeReproductionCursor(created, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}

export interface MarkReproductionReadyInput {
  code: string;
  hasRedactedSteps: boolean;
}

/**
 * Marks a reproduction ready with its generated Playwright source.
 * Sets `completed_at` exactly once; clears any previous error diagnostics.
 */
export async function markReproductionReady(
  tx: DbTransaction,
  reproductionId: string,
  input: MarkReproductionReadyInput,
): Promise<ReproductionRow | undefined> {
  const rows = await tx
    .update(reproductionTests)
    .set({
      status: "ready",
      code: input.code,
      hasRedactedSteps: input.hasRedactedSteps,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
    })
    .where(eq(reproductionTests.id, reproductionId))
    .returning();
  return rows[0];
}

export interface MarkReproductionFailedInput {
  errorCode: ReproductionErrorCode;
  errorMessage: string;
}

/**
 * Marks a reproduction failed with a machine-readable error code and a
 * sanitized message. Sets `completed_at` exactly once.
 */
export async function markReproductionFailed(
  tx: DbTransaction,
  reproductionId: string,
  input: MarkReproductionFailedInput,
): Promise<ReproductionRow | undefined> {
  const rows = await tx
    .update(reproductionTests)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      completedAt: new Date(),
    })
    .where(eq(reproductionTests.id, reproductionId))
    .returning();
  return rows[0];
}

export interface CreateReproductionActivityInput {
  issueId: string;
  actorUserId: string | null;
  reproductionId: string;
}

/**
 * Appends the `reproduction_generated` timeline row with an exactly-once
 * guard: when a row for this reproduction already exists (matched by
 * `metadata_json.reproductionId`), the existing row is returned and no
 * duplicate is inserted. Retried generation completions stay idempotent.
 */
export async function insertReproductionActivity(
  tx: DbTransaction,
  input: CreateReproductionActivityInput,
): Promise<typeof issueActivity.$inferSelect | undefined> {
  const existing = await tx
    .select()
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, input.issueId),
        eq(issueActivity.type, "reproduction_generated"),
        sql`${issueActivity.metadataJson} ->> 'reproductionId' = ${input.reproductionId}`,
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found !== undefined) {
    return found;
  }
  const rows = await tx
    .insert(issueActivity)
    .values({
      issueId: input.issueId,
      actorUserId: input.actorUserId,
      type: "reproduction_generated",
      metadataJson: { reproductionId: input.reproductionId },
    })
    .returning();
  return rows[0];
}

export interface PendingReproductionOutboxItem {
  reproductionId: string;
  attemptCount: number;
  createdAt: Date;
}

/** Outbox row columns needed by dispatchers; keeps code payloads out of memory. */
const pendingReproductionColumns = {
  reproductionId: reproductionGenerationOutbox.reproductionId,
  attemptCount: reproductionGenerationOutbox.attemptCount,
  createdAt: reproductionGenerationOutbox.createdAt,
};

/**
 * Insert outbox row for a reproduction (same transaction as the pending
 * reproduction insert).
 */
export async function insertReproductionOutbox(
  tx: DbTransaction,
  reproductionId: string,
): Promise<ReproductionOutboxRow> {
  const rows = await tx
    .insert(reproductionGenerationOutbox)
    .values({
      reproductionId,
      dispatchedAt: null,
      attemptCount: 0,
      lastError: null,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert reproduction outbox row");
  }
  return row;
}

/**
 * Claims a bounded batch of undispatched rows for this transaction.
 *
 * `FOR UPDATE SKIP LOCKED` gives safe multi-worker behavior: concurrent
 * dispatchers skip rows another transaction already holds instead of
 * blocking or double-publishing. Ordering is stable
 * (created_at, reproduction_id) and the batch is bounded by the caller, so
 * the whole table is never selected.
 */
export async function claimPendingReproductionOutboxBatch(
  tx: DbTransaction,
  limit: number,
): Promise<PendingReproductionOutboxItem[]> {
  return tx
    .select(pendingReproductionColumns)
    .from(reproductionGenerationOutbox)
    .where(isNull(reproductionGenerationOutbox.dispatchedAt))
    .orderBy(
      asc(reproductionGenerationOutbox.createdAt),
      asc(reproductionGenerationOutbox.reproductionId),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Marks a row as durably handed to pg-boss. Only call after the publish
 * confirmed (a job id or a deduplicated no-op), never before.
 */
export async function markReproductionOutboxDispatched(
  tx: DbTransaction,
  reproductionId: string,
): Promise<void> {
  await tx
    .update(reproductionGenerationOutbox)
    .set({ dispatchedAt: sql`now()`, lastError: null })
    .where(eq(reproductionGenerationOutbox.reproductionId, reproductionId));
}

/**
 * Claims a bounded batch of rows that have been pending longer than
 * `staleBefore`. Used by reconciliation to retry long-pending dispatches.
 */
export async function claimStaleReproductionOutboxBatch(
  tx: DbTransaction,
  staleBefore: Date,
  limit: number,
): Promise<PendingReproductionOutboxItem[]> {
  return tx
    .select(pendingReproductionColumns)
    .from(reproductionGenerationOutbox)
    .where(
      and(
        isNull(reproductionGenerationOutbox.dispatchedAt),
        lte(reproductionGenerationOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(
      asc(reproductionGenerationOutbox.createdAt),
      asc(reproductionGenerationOutbox.reproductionId),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Lists long-pending rows without locking (diagnostics/reporting).
 */
export async function listStaleReproductionOutbox(
  db: DbOrTx,
  staleBefore: Date,
  limit: number,
): Promise<PendingReproductionOutboxItem[]> {
  return db
    .select(pendingReproductionColumns)
    .from(reproductionGenerationOutbox)
    .where(
      and(
        isNull(reproductionGenerationOutbox.dispatchedAt),
        lte(reproductionGenerationOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(
      asc(reproductionGenerationOutbox.createdAt),
      asc(reproductionGenerationOutbox.reproductionId),
    )
    .limit(limit);
}

/**
 * Records a bounded, sanitized publish failure. `attempt_count` increments;
 * the row stays pending so the next dispatch attempt can retry it.
 */
export async function recordReproductionOutboxFailure(
  tx: DbTransaction,
  reproductionId: string,
  sanitizedError: string,
): Promise<void> {
  await tx
    .update(reproductionGenerationOutbox)
    .set({
      attemptCount: sql`${reproductionGenerationOutbox.attemptCount} + 1`,
      lastError: sanitizedError,
    })
    .where(eq(reproductionGenerationOutbox.reproductionId, reproductionId));
}
