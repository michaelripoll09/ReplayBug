import { and, asc, eq, lte, or, sql, type SQL } from "drizzle-orm";
import {
  telemetrySessions,
  events,
  rateLimitBuckets,
  projectKeys,
  projectOrigins,
} from "../schema.js";
import type { Database, DbOrTx, DbTransaction } from "./db-types.js";

export type TelemetrySessionRow = typeof telemetrySessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type ProjectKeyRow = typeof projectKeys.$inferSelect;
export type ProjectOriginRow = typeof projectOrigins.$inferSelect;

export interface CreateTelemetrySessionInput {
  projectId: string;
  sdkSessionId: string;
  anonymousUserHash: string | null;
  environment: string;
  release: string | null;
  initialUrl: string;
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  deviceType: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  sdkVersion: string;
}

export interface UpdateTelemetrySessionInput {
  lastSeenAt: Date;
  anonymousUserHash?: string | null;
  environment?: string;
  release?: string | null;
}

/**
 * Upsert telemetry session by (project_id, sdk_session_id).
 * Creates new session or updates last_seen_at and metadata.
 */
export async function upsertTelemetrySession(
  db: DbOrTx,
  input: CreateTelemetrySessionInput,
): Promise<TelemetrySessionRow> {
  const now = new Date();
  const rows = await db
    .insert(telemetrySessions)
    .values({
      projectId: input.projectId,
      sdkSessionId: input.sdkSessionId,
      anonymousUserHash: input.anonymousUserHash,
      environment: input.environment,
      release: input.release,
      startedAt: now,
      lastSeenAt: now,
      initialUrl: input.initialUrl,
      browserName: input.browserName,
      browserVersion: input.browserVersion,
      osName: input.osName,
      osVersion: input.osVersion,
      deviceType: input.deviceType,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
      sdkVersion: input.sdkVersion,
    })
    .onConflictDoUpdate({
      target: [telemetrySessions.projectId, telemetrySessions.sdkSessionId],
      set: {
        lastSeenAt: now,
        anonymousUserHash: input.anonymousUserHash,
        environment: input.environment,
        release: input.release,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to upsert telemetry session");
  }
  return row;
}

/**
 * Find telemetry session by project_id and sdk_session_id.
 */
export async function findTelemetrySession(
  db: DbOrTx,
  projectId: string,
  sdkSessionId: string,
): Promise<TelemetrySessionRow | undefined> {
  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.projectId, projectId),
        eq(telemetrySessions.sdkSessionId, sdkSessionId),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Insert event with idempotency on (project_id, client_event_id).
 * Returns the inserted row or undefined if duplicate.
 */
export async function insertEvent(
  db: DbOrTx,
  values: {
    projectId: string;
    telemetrySessionId: string;
    clientEventId: string;
    sequenceNumber: number;
    eventType: string;
    occurredAt: Date;
    environment: string;
    release: string | null;
    pageUrl: string | null;
    payloadJson: Record<string, unknown>;
  },
): Promise<EventRow | undefined> {
  const rows = await db
    .insert(events)
    .values({
      projectId: values.projectId,
      telemetrySessionId: values.telemetrySessionId,
      clientEventId: values.clientEventId,
      sequenceNumber: values.sequenceNumber,
      eventType: values.eventType,
      occurredAt: values.occurredAt,
      environment: values.environment,
      release: values.release,
      pageUrl: values.pageUrl,
      payloadJson: values.payloadJson,
      processingState: "pending",
    })
    .onConflictDoNothing({
      target: [events.projectId, events.clientEventId],
    })
    .returning();

  return rows[0];
}

/**
 * Check if event exists (for idempotent duplicate detection).
 */
export async function eventExists(
  db: DbOrTx,
  projectId: string,
  clientEventId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        eq(events.clientEventId, clientEventId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Rate limit bucket operations.
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  requestCount: number;
  eventCount: number;
  retryAfterSeconds: number | null;
}

export async function checkAndIncrementRateLimit(
  db: DbOrTx,
  projectId: string,
  keyPrefix: string,
  maxRequestsPerMinute: number,
  maxEventsPerMinute: number,
  eventCount: number,
): Promise<RateLimitCheckResult> {
  const now = new Date();
  const bucketStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ),
  );

  const result = await db
    .insert(rateLimitBuckets)
    .values({
      projectId,
      keyPrefix,
      bucketStart,
      requestCount: 1,
      eventCount,
    })
    .onConflictDoUpdate({
      target: [
        rateLimitBuckets.projectId,
        rateLimitBuckets.keyPrefix,
        rateLimitBuckets.bucketStart,
      ],
      set: {
        requestCount: sql`${rateLimitBuckets.requestCount} + 1`,
        eventCount: sql`${rateLimitBuckets.eventCount} + ${eventCount}`,
      },
    })
    .returning();

  const bucket = result[0];
  if (!bucket) {
    throw new Error("Failed to upsert rate limit bucket");
  }

  const requestExceeded = bucket.requestCount > maxRequestsPerMinute;
  const eventExceeded = bucket.eventCount > maxEventsPerMinute;
  const allowed = !requestExceeded && !eventExceeded;

  let retryAfterSeconds: number | null = null;
  if (!allowed) {
    const nextBucketStart = new Date(bucketStart.getTime() + 60 * 1000);
    retryAfterSeconds = Math.ceil(
      (nextBucketStart.getTime() - now.getTime()) / 1000,
    );
  }

  return {
    allowed,
    requestCount: bucket.requestCount,
    eventCount: bucket.eventCount,
    retryAfterSeconds,
  };
}

/**
 * Find key by prefix (for ingest auth)
 */
export async function findKeyByPrefix(
  db: DbOrTx,
  prefix: string,
): Promise<ProjectKeyRow | undefined> {
  const rows = await db
    .select()
    .from(projectKeys)
    .where(eq(projectKeys.prefix, prefix))
    .limit(1);
  return rows[0];
}

/**
 * List origins by project
 */
export async function listOriginsByProject(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectOriginRow[]> {
  return db
    .select()
    .from(projectOrigins)
    .where(eq(projectOrigins.projectId, projectId));
}

/** Maximum rows selected by one rate-limit cleanup transaction. */
export const MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE = 1000;
export const DEFAULT_RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;
const MAX_RATE_LIMIT_AGE_MINUTES = 60 * 24 * 365;

function boundedRateLimitCleanupBatchSize(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE
  ) {
    throw new RangeError(
      `Rate-limit cleanup batch size must be an integer between 1 and ${MAX_RATE_LIMIT_CLEANUP_BATCH_SIZE}`,
    );
  }
  return limit;
}

function boundedRateLimitAge(olderThanMinutes: number): number {
  if (
    !Number.isInteger(olderThanMinutes) ||
    olderThanMinutes < 0 ||
    olderThanMinutes > MAX_RATE_LIMIT_AGE_MINUTES
  ) {
    throw new RangeError(
      `Rate-limit cleanup age must be an integer between 0 and ${MAX_RATE_LIMIT_AGE_MINUTES} minutes`,
    );
  }
  return olderThanMinutes;
}

function assertRateLimitCleanupDate(now: Date): void {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Rate-limit cleanup now must be a valid date");
  }
}

function isDatabase(db: DbOrTx): db is Database {
  return (
    typeof (db as unknown as { transaction?: unknown }).transaction ===
    "function"
  );
}

/**
 * Deletes one bounded, deterministic batch of old rate-limit buckets.
 *
 * Selection and deletion happen in the same transaction. Row locks with
 * `SKIP LOCKED` make concurrent workers partition the batch instead of
 * blocking each other or selecting the same bucket twice.
 */
export async function cleanupRateLimitBuckets(
  db: DbOrTx,
  olderThanMinutes = 60,
  limit = DEFAULT_RATE_LIMIT_CLEANUP_BATCH_SIZE,
  now = new Date(),
): Promise<number> {
  const age = boundedRateLimitAge(olderThanMinutes);
  const batchSize = boundedRateLimitCleanupBatchSize(limit);
  assertRateLimitCleanupDate(now);

  if (isDatabase(db)) {
    return db.transaction((tx) =>
      cleanupRateLimitBucketsInTransaction(tx, age, batchSize, now),
    );
  }
  return cleanupRateLimitBucketsInTransaction(db, age, batchSize, now);
}

/** Transaction-bound variant used when retention cleans multiple tables atomically. */
export async function cleanupRateLimitBucketsInTransaction(
  tx: DbTransaction,
  olderThanMinutes = 60,
  limit = DEFAULT_RATE_LIMIT_CLEANUP_BATCH_SIZE,
  now = new Date(),
): Promise<number> {
  const age = boundedRateLimitAge(olderThanMinutes);
  const batchSize = boundedRateLimitCleanupBatchSize(limit);
  assertRateLimitCleanupDate(now);
  const cutoff = new Date(now.getTime() - age * 60 * 1000);
  const candidates = await tx
    .select({
      projectId: rateLimitBuckets.projectId,
      keyPrefix: rateLimitBuckets.keyPrefix,
      bucketStart: rateLimitBuckets.bucketStart,
    })
    .from(rateLimitBuckets)
    .where(lte(rateLimitBuckets.bucketStart, cutoff))
    .orderBy(
      asc(rateLimitBuckets.bucketStart),
      asc(rateLimitBuckets.projectId),
      asc(rateLimitBuckets.keyPrefix),
    )
    .limit(batchSize)
    .for("update", { skipLocked: true });

  if (candidates.length === 0) {
    return 0;
  }

  const predicates: SQL[] = [];
  for (const candidate of candidates) {
    const predicate = and(
      eq(rateLimitBuckets.projectId, candidate.projectId),
      eq(rateLimitBuckets.keyPrefix, candidate.keyPrefix),
      eq(rateLimitBuckets.bucketStart, candidate.bucketStart),
    );
    if (predicate !== undefined) {
      predicates.push(predicate);
    }
  }
  const predicate = or(...predicates);
  if (predicate === undefined) {
    return 0;
  }

  const result = await tx.delete(rateLimitBuckets).where(predicate);
  return result.rowCount ?? 0;
}
