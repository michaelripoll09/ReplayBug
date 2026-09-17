import { type Logger } from "@replaybug/observability";

/**
 * Foundation job registry stub.
 *
 * Future pg-boss jobs (event normalization, fingerprinting, issue grouping,
 * retention cleanup, outbox dispatch, ...) will register here with an
 * idempotent handler plus queue options. No functional jobs exist yet: the
 * registry intentionally starts empty so later blocks add jobs without
 * touching the worker entrypoint.
 */
export interface JobDefinition {
  readonly name: string;
}

const definitions: JobDefinition[] = [];

export function listJobDefinitions(): readonly JobDefinition[] {
  return definitions;
}

/** Register a future job definition. Reserved for later blocks. */
export function registerJob(definition: JobDefinition): void {
  definitions.push(definition);
}

export async function startJobs(_logger: Logger): Promise<void> {
  // No queues to start yet. Kept as an explicit step so the entrypoint
  // already reflects the future start order: config -> PG check -> jobs.
}
