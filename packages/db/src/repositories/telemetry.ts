import { and, eq, lte, sql } from "drizzle-orm";
import {
  telemetrySessions,
  events,
  eventProcessingOutbox,
  rateLimitBuckets,
  projectKeys,
  projectOrigins,
} from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type TelemetrySessionRow = typeof telemetrySessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type OutboxRow = typeof eventProcessingOutbox.$inferSelect;
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
 * Insert outbox row for an event (same transaction as event insert).
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

/**
 * Clean up old rate limit buckets (older than 1 hour).
 * Intended to be called by a scheduled job.
 */
export async function cleanupRateLimitBuckets(
  db: DbOrTx,
  olderThanMinutes = 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const result = await db
    .delete(rateLimitBuckets)
    .where(lte(rateLimitBuckets.bucketStart, cutoff));
  return result.rowCount ?? 0;
}
