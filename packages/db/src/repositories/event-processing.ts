import { eq } from "drizzle-orm";
import { events, projects } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type EventProcessingState = "pending" | "processed" | "rejected";

export interface EventForProcessing {
  id: string;
  projectId: string;
  workspaceId: string;
  telemetrySessionId: string;
  clientEventId: string;
  eventType: string;
  occurredAt: Date;
  release: string | null;
  payloadJson: unknown;
  processingState: EventProcessingState;
}

/**
 * Locks one event row for processing and loads the project context the
 * processor needs (workspace id for notifications).
 *
 * `FOR UPDATE OF events` locks only the event row, not the joined project,
 * so unrelated ingest traffic on the same project is never blocked.
 * Concurrent processors of the same event serialize here; the second one
 * observes `processing_state = processed` after the first commits and no-ops.
 */
export async function lockEventForProcessing(
  tx: DbTransaction,
  eventId: string,
): Promise<EventForProcessing | undefined> {
  const rows = await tx
    .select({
      id: events.id,
      projectId: events.projectId,
      workspaceId: projects.workspaceId,
      telemetrySessionId: events.telemetrySessionId,
      clientEventId: events.clientEventId,
      eventType: events.eventType,
      occurredAt: events.occurredAt,
      release: events.release,
      payloadJson: events.payloadJson,
      processingState: events.processingState,
    })
    .from(events)
    .innerJoin(projects, eq(events.projectId, projects.id))
    .where(eq(events.id, eventId))
    .limit(1)
    .for("update", { of: events });
  return rows[0];
}

/**
 * Immutable preload for RS-08 symbolication (step A).
 *
 * Reads the event WITHOUT a row lock so the worker can resolve artifacts
 * and run source-map math (file I/O) before the issue transaction begins.
 * Events are immutable after ingest, so the payload observed here matches
 * the locked row inside the transaction. Returns undefined when the event
 * does not exist (terminal: acknowledge without retrying).
 */
export interface EventSymbolicationPreload {
  id: string;
  projectId: string;
  release: string | null;
  eventType: string;
  payloadJson: unknown;
}

export async function getEventForSymbolication(
  db: DbOrTx,
  eventId: string,
): Promise<EventSymbolicationPreload | undefined> {
  const rows = await db
    .select({
      id: events.id,
      projectId: events.projectId,
      release: events.release,
      eventType: events.eventType,
      payloadJson: events.payloadJson,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0];
}

/**
 * Persists the precomputed RS-08 symbolication result as JSONB enrichment
 * (step F). The public-ingest `payload_json` is never touched — raw frames
 * live on inside the enrichment, never overwritten. Call inside the issue
 * transaction, after locking the event and before grouping/aggregates.
 */
export async function persistEventSymbolication(
  tx: DbTransaction,
  input: {
    eventId: string;
    symbolication: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .update(events)
    .set({ symbolicationJson: input.symbolication })
    .where(eq(events.id, input.eventId));
}

/**
 * Marks the event processed and stores its fingerprint/issue association.
 */
export async function markEventProcessed(
  tx: DbTransaction,
  input: {
    eventId: string;
    fingerprint: string | null;
    issueId: string | null;
  },
): Promise<void> {
  await tx
    .update(events)
    .set({
      processingState: "processed",
      fingerprint: input.fingerprint,
      issueId: input.issueId,
    })
    .where(eq(events.id, input.eventId));
}

/**
 * Marks the event rejected with a safe machine-readable reason. Used only for
 * deterministic stored-event problems; transient failures must throw instead
 * so pg-boss retries them.
 */
export async function markEventRejected(
  tx: DbTransaction,
  input: { eventId: string; rejectionReason: string },
): Promise<void> {
  await tx
    .update(events)
    .set({
      processingState: "rejected",
      rejectionReason: input.rejectionReason,
    })
    .where(eq(events.id, input.eventId));
}
