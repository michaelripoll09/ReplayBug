import type { Job } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import { processEvent, type ProcessEventDeps } from "./process-event.js";
import { processEventJobSchema } from "../queues/process-event.js";

export interface ProcessEventJobHandlerDeps extends ProcessEventDeps {
  logger: Logger;
}

/**
 * pg-boss consumer for `replaybug.process-event`.
 *
 * The handler validates the versioned job payload with Zod, re-reads the event
 * from PostgreSQL and delegates to `processEvent`. Thrown errors become
 * pg-boss failures (bounded retries, then a terminal `failed` job), so
 * transient PostgreSQL problems retry instead of being silently dropped.
 *
 * Logs carry job/event identifiers, duration and result only: never the
 * stored telemetry payload.
 */
export function createProcessEventJobHandler(
  deps: ProcessEventJobHandlerDeps,
): (jobs: Job<unknown>[]) => Promise<void> {
  return async function handleProcessEventJobs(
    jobs: Job<unknown>[],
  ): Promise<void> {
    for (const job of jobs) {
      const parsed = processEventJobSchema.safeParse(job.data);
      if (!parsed.success) {
        deps.logger.error(
          { jobId: job.id, jobName: job.name },
          "process-event job payload failed contract validation",
        );
        throw new Error("invalid replaybug.process-event job payload");
      }

      const eventId = parsed.data.eventId;
      const startedAt = Date.now();
      try {
        const outcome = await processEvent(deps, eventId);
        deps.logger.info(
          {
            jobId: job.id,
            jobName: job.name,
            eventId,
            projectId:
              outcome.status === "event-not-found"
                ? undefined
                : outcome.projectId,
            issueId:
              outcome.status === "processed" ||
              outcome.status === "already-processed"
                ? outcome.issueId
                : undefined,
            result: outcome.status,
            durationMs: Date.now() - startedAt,
          },
          "process-event completed",
        );
      } catch (error) {
        deps.logger.error(
          {
            jobId: job.id,
            jobName: job.name,
            eventId,
            durationMs: Date.now() - startedAt,
            err: error,
          },
          "process-event failed; pg-boss will retry or fail the job",
        );
        throw error;
      }
    }
  };
}
