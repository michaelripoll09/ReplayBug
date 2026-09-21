import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import {
  eventProcessingOutbox,
  events,
  issueAffectedSessions,
  projects,
  reproductionTests,
  telemetrySessions,
} from "../schema.js";
import { cleanupRateLimitBucketsInTransaction } from "./telemetry.js";
import type { Database, DbTransaction } from "./db-types.js";

export const MAX_RETENTION_CLEANUP_BATCH_SIZE = 1000;
export const DEFAULT_RETENTION_CLEANUP_BATCH_SIZE = 100;
export const DEFAULT_RATE_LIMIT_CLEANUP_AGE_MINUTES = 60;

export interface RetentionCleanupBatchOptions {
  /** Maximum number of rows selected per cleanup category in one transaction. */
  batchSize: number;
  /** UTC instant used for every project cutoff in this pass. */
  now?: Date;
  /** Rate-limit buckets older than this many minutes are eligible. */
  rateLimitOlderThanMinutes?: number;
}

export interface RetentionCleanupBatchResult {
  eventsDeleted: number;
  sessionsDeleted: number;
  rateLimitBucketsDeleted: number;
}

function boundedBatchSize(batchSize: number): number {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_RETENTION_CLEANUP_BATCH_SIZE
  ) {
    throw new RangeError(
      `Retention cleanup batch size must be an integer between 1 and ${MAX_RETENTION_CLEANUP_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

function validNow(now: Date): Date {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Retention cleanup now must be a valid date");
  }
  return now;
}

/**
 * Correlated eligibility predicates for raw event expiry.
 *
 * The event row is locked before these predicates are rechecked. That second
 * read is intentional: a pending reproduction inserted before the lock is
 * acquired must protect its source event, while a reproduction inserted after
 * the lock cannot pass its parent-event foreign-key lock until this deletion
 * commits or rolls back.
 */
function eligibleEventConditions(
  tx: DbTransaction,
  now: Date,
): ReturnType<typeof and>[] {
  return [
    sql`${events.occurredAt} < ${now}::timestamptz - (${projects.retentionDays} * interval '1 day')`,
    sql`${events.processingState} IN ('processed', 'rejected')`,
    notExists(
      tx
        .select({ eventId: eventProcessingOutbox.eventId })
        .from(eventProcessingOutbox)
        .where(
          and(
            eq(eventProcessingOutbox.eventId, events.id),
            isNull(eventProcessingOutbox.dispatchedAt),
          ),
        ),
    ),
    notExists(
      tx
        .select({ eventId: reproductionTests.eventId })
        .from(reproductionTests)
        .where(
          and(
            eq(reproductionTests.eventId, events.id),
            eq(reproductionTests.status, "pending"),
          ),
        ),
    ),
  ];
}

async function deleteEligibleEvents(
  tx: DbTransaction,
  now: Date,
  batchSize: number,
): Promise<number> {
  const candidates = await tx
    .select({ id: events.id })
    .from(events)
    .innerJoin(projects, eq(events.projectId, projects.id))
    .where(and(...eligibleEventConditions(tx, now)))
    .orderBy(asc(events.occurredAt), asc(events.projectId), asc(events.id))
    .limit(batchSize)
    .for("update", { of: events, skipLocked: true });
  const candidateIds = candidates.map((candidate) => candidate.id);
  if (candidateIds.length === 0) {
    return 0;
  }

  // Recheck all mutable protection/state predicates after acquiring locks.
  const eligible = await tx
    .select({ id: events.id })
    .from(events)
    .innerJoin(projects, eq(events.projectId, projects.id))
    .where(
      and(
        inArray(events.id, candidateIds),
        ...eligibleEventConditions(tx, now),
      ),
    )
    .orderBy(asc(events.occurredAt), asc(events.projectId), asc(events.id));
  const eligibleIds = eligible.map((event) => event.id);
  if (eligibleIds.length === 0) {
    return 0;
  }

  const deleted = await tx
    .delete(events)
    .where(inArray(events.id, eligibleIds))
    .returning({ id: events.id });
  return deleted.length;
}

/**
 * Session expiry deliberately preserves issue_affected_sessions rows.
 * That relation is the lifetime distinct-session deduplication key; deleting
 * it would allow a later event from the same session to double-count an issue.
 * No historical-identity migration is needed because the relation remains.
 */
function eligibleSessionConditions(
  tx: DbTransaction,
  now: Date,
): ReturnType<typeof and>[] {
  return [
    sql`${telemetrySessions.lastSeenAt} < ${now}::timestamptz - (${projects.retentionDays} * interval '1 day')`,
    notExists(
      tx
        .select({ eventId: events.id })
        .from(events)
        .where(eq(events.telemetrySessionId, telemetrySessions.id)),
    ),
    notExists(
      tx
        .select({ issueId: issueAffectedSessions.issueId })
        .from(issueAffectedSessions)
        .where(
          eq(issueAffectedSessions.telemetrySessionId, telemetrySessions.id),
        ),
    ),
  ];
}

async function deleteEligibleSessions(
  tx: DbTransaction,
  now: Date,
  batchSize: number,
): Promise<number> {
  const candidates = await tx
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .innerJoin(projects, eq(telemetrySessions.projectId, projects.id))
    .where(and(...eligibleSessionConditions(tx, now)))
    .orderBy(
      asc(telemetrySessions.lastSeenAt),
      asc(telemetrySessions.projectId),
      asc(telemetrySessions.id),
    )
    .limit(batchSize)
    .for("update", { of: telemetrySessions, skipLocked: true });
  const candidateIds = candidates.map((candidate) => candidate.id);
  if (candidateIds.length === 0) {
    return 0;
  }

  // The parent row lock makes the child recheck race-safe against ingest and
  // issue-session inserts, both of which take a foreign-key key-share lock.
  const eligible = await tx
    .select({ id: telemetrySessions.id })
    .from(telemetrySessions)
    .innerJoin(projects, eq(telemetrySessions.projectId, projects.id))
    .where(
      and(
        inArray(telemetrySessions.id, candidateIds),
        ...eligibleSessionConditions(tx, now),
      ),
    )
    .orderBy(
      asc(telemetrySessions.lastSeenAt),
      asc(telemetrySessions.projectId),
      asc(telemetrySessions.id),
    );
  const eligibleIds = eligible.map((session) => session.id);
  if (eligibleIds.length === 0) {
    return 0;
  }

  const deleted = await tx
    .delete(telemetrySessions)
    .where(inArray(telemetrySessions.id, eligibleIds))
    .returning({ id: telemetrySessions.id });
  return deleted.length;
}

/**
 * Runs one bounded, idempotent retention pass in one PostgreSQL transaction.
 * A later pass resumes from rows that were skipped or rolled back.
 */
export async function runRetentionCleanupBatch(
  db: Database,
  options: RetentionCleanupBatchOptions,
): Promise<RetentionCleanupBatchResult> {
  const batchSize = boundedBatchSize(options.batchSize);
  const now = validNow(options.now ?? new Date());
  const rateLimitOlderThanMinutes =
    options.rateLimitOlderThanMinutes ?? DEFAULT_RATE_LIMIT_CLEANUP_AGE_MINUTES;

  return db.transaction(async (tx) => {
    const eventsDeleted = await deleteEligibleEvents(tx, now, batchSize);
    const sessionsDeleted = await deleteEligibleSessions(tx, now, batchSize);
    const rateLimitBucketsDeleted = await cleanupRateLimitBucketsInTransaction(
      tx,
      rateLimitOlderThanMinutes,
      batchSize,
      now,
    );
    return { eventsDeleted, sessionsDeleted, rateLimitBucketsDeleted };
  });
}
