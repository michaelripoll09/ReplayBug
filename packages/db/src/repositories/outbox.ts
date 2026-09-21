import { asc, isNull, lte, and, eq, sql } from "drizzle-orm";
import { eventProcessingOutbox } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type OutboxRow = typeof eventProcessingOutbox.$inferSelect;

export interface PendingOutboxItem {
  eventId: string;
  attemptCount: number;
  createdAt: Date;
}

/** Outbox row columns needed by dispatchers; keeps payloads out of memory. */
const pendingColumns = {
  eventId: eventProcessingOutbox.eventId,
  attemptCount: eventProcessingOutbox.attemptCount,
  createdAt: eventProcessingOutbox.createdAt,
};

/**
 * Insert outbox row for an event (same transaction as the event insert).
 */
export async function insertOutbox(
  db: DbOrTx,
  eventId: string,
): Promise<OutboxRow> {
  const rows = await db
    .insert(eventProcessingOutbox)
    .values({
      eventId,
      dispatchedAt: null,
      attemptCount: 0,
      lastError: null,
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert outbox row");
  }
  return row;
}

/**
 * Claims a bounded batch of undispatched rows for this transaction.
 *
 * `FOR UPDATE SKIP LOCKED` gives safe multi-worker behavior: concurrent
 * dispatchers skip rows another transaction already holds instead of
 * blocking or double-publishing. Ordering is stable (created_at, event_id)
 * and the batch is bounded by the caller, so the whole table is never
 * selected.
 */
export async function claimPendingOutboxBatch(
  tx: DbTransaction,
  limit: number,
): Promise<PendingOutboxItem[]> {
  return tx
    .select(pendingColumns)
    .from(eventProcessingOutbox)
    .where(isNull(eventProcessingOutbox.dispatchedAt))
    .orderBy(
      asc(eventProcessingOutbox.createdAt),
      asc(eventProcessingOutbox.eventId),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Claims a bounded batch of rows that have been pending longer than
 * `staleBefore`. Used by reconciliation to retry long-pending dispatches.
 */
export async function claimStaleOutboxBatch(
  tx: DbTransaction,
  staleBefore: Date,
  limit: number,
): Promise<PendingOutboxItem[]> {
  return tx
    .select(pendingColumns)
    .from(eventProcessingOutbox)
    .where(
      and(
        isNull(eventProcessingOutbox.dispatchedAt),
        lte(eventProcessingOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(
      asc(eventProcessingOutbox.createdAt),
      asc(eventProcessingOutbox.eventId),
    )
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Lists long-pending rows without locking (diagnostics/reporting).
 */
export async function listStaleOutbox(
  db: DbOrTx,
  staleBefore: Date,
  limit: number,
): Promise<PendingOutboxItem[]> {
  return db
    .select(pendingColumns)
    .from(eventProcessingOutbox)
    .where(
      and(
        isNull(eventProcessingOutbox.dispatchedAt),
        lte(eventProcessingOutbox.createdAt, staleBefore),
      ),
    )
    .orderBy(
      asc(eventProcessingOutbox.createdAt),
      asc(eventProcessingOutbox.eventId),
    )
    .limit(limit);
}

/**
 * Marks a row as durably handed to pg-boss. Only call after the publish
 * confirmed (a job id or a deduplicated no-op), never before.
 */
export async function markOutboxDispatched(
  tx: DbTransaction,
  eventId: string,
): Promise<void> {
  await tx
    .update(eventProcessingOutbox)
    .set({ dispatchedAt: sql`now()`, lastError: null })
    .where(eq(eventProcessingOutbox.eventId, eventId));
}

/**
 * Records a bounded, sanitized publish failure. `attempt_count` increments;
 * the row stays pending so the next dispatch attempt can retry it.
 */
export async function recordOutboxDispatchFailure(
  tx: DbTransaction,
  eventId: string,
  sanitizedError: string,
): Promise<void> {
  await tx
    .update(eventProcessingOutbox)
    .set({
      attemptCount: sql`${eventProcessingOutbox.attemptCount} + 1`,
      lastError: sanitizedError,
    })
    .where(eq(eventProcessingOutbox.eventId, eventId));
}
