import { z } from "zod";
import type { Queue } from "pg-boss";
import type { WorkerConfig } from "../config.js";

/**
 * Job contract for Playwright reproduction generation.
 *
 * The payload is deliberately minimal and versioned: it carries only the
 * reproduction id. The worker re-reads the reproduction + evidence from
 * PostgreSQL, so pg-boss never stores code, payloads or secrets, jobs stay
 * small, and DB/job state cannot drift.
 */
export const GENERATE_REPRODUCTION_QUEUE = "replaybug.generate-reproduction";
export const GENERATE_REPRODUCTION_JOB_VERSION = 1;

export const generateReproductionJobSchema = z.object({
  version: z.literal(GENERATE_REPRODUCTION_JOB_VERSION),
  reproductionId: z.string().uuid(),
});

export type GenerateReproductionJob = z.infer<
  typeof generateReproductionJobSchema
>;

export function buildGenerateReproductionJob(
  reproductionId: string,
): GenerateReproductionJob {
  return {
    version: GENERATE_REPRODUCTION_JOB_VERSION,
    reproductionId,
  };
}

/**
 * Queue-level defaults inherited by every generate-reproduction job.
 * Bounded retries with backoff; poison jobs end in pg-boss's `failed`
 * state with output/retry metadata for inspection. Deterministic
 * generation failures never throw (they mark the row failed), so retries
 * only cover transient DB/publish problems.
 */
export function generateReproductionQueueOptions(
  config: WorkerConfig,
): Omit<Queue, "name"> {
  return {
    retryLimit: config.jobRetryLimit,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 60,
    expireInSeconds: 120,
  };
}

/**
 * Stable job identity: one generate-reproduction job id per reproduction.
 *
 * pg-boss inserts with `ON CONFLICT DO NOTHING` on the (name, id) primary
 * key and returns null when the job already exists. A dispatcher crash
 * between publishing and marking the outbox row therefore re-publishes
 * safely: the second send is deduplicated, and the processor is idempotent
 * by DB state regardless.
 */
export function generateReproductionSendOptions(reproductionId: string): {
  id: string;
} {
  return { id: reproductionId };
}
