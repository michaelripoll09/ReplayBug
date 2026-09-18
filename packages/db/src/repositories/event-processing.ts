import { eq } from "drizzle-orm";
import { events, projects } from "../schema.js";
import type { DbTransaction } from "./db-types.js";

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
