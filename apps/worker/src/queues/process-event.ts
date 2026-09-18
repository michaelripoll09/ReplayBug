import { z } from "zod";
import type { Queue } from "pg-boss";
import type { WorkerConfig } from "../config.js";

/**
 * Job contract for telemetry event processing.
 *
 * The payload is deliberately minimal and versioned: it carries only the
 * event id. The worker re-reads the event from PostgreSQL, so pg-boss never
 * stores telemetry payloads, jobs stay small, and DB/job state cannot drift.
 */
export const PROCESS_EVENT_QUEUE = "replaybug.process-event";
export const PROCESS_EVENT_JOB_VERSION = 1;

export const processEventJobSchema = z.object({
  version: z.literal(PROCESS_EVENT_JOB_VERSION),
  eventId: z.string().uuid(),
});

export type ProcessEventJob = z.infer<typeof processEventJobSchema>;

export function buildProcessEventJob(eventId: string): ProcessEventJob {
  return { version: PROCESS_EVENT_JOB_VERSION, eventId };
}

/**
 * Queue-level defaults inherited by every process-event job.
 * Bounded retries with exponential backoff; poison jobs end in pg-boss's
 * `failed` state with output/retry metadata for inspection.
 */
export function processEventQueueOptions(
  config: WorkerConfig,
): Omit<Queue, "name"> {
  return {
    retryLimit: config.jobRetryLimit,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 60,
    expireInSeconds: 60,
  };
}

/**
 * Stable job identity: one process-event job id per event.
 *
 * pg-boss inserts with `ON CONFLICT DO NOTHING` on the (name, id) primary key
 * and returns null when the job already exists. A dispatcher crash between
 * publishing and marking the outbox row therefore re-publishes safely: the
 * second send is deduplicated, and the processor is idempotent by DB state
 * regardless.
 */
export function processEventSendOptions(eventId: string): { id: string } {
  return { id: eventId };
}
