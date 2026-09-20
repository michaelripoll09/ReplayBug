import { z } from "zod";

/**
 * Validated worker runtime configuration. Fails fast with a human-readable
 * message when required values are missing or out of safe bounds so
 * misconfiguration surfaces at startup instead of as a silent idle worker.
 *
 * All values are parsed here; no other module reads process.env directly.
 */
export const workerConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  environment: z.string().min(1).default("development"),
  databaseUrl: z.string().min(1, "REPLAYBUG_DATABASE_URL must not be empty"),
  logLevel: z.string().min(1).default("info"),
  /** pg-boss-owned schema (tables are created/maintained by pg-boss itself). */
  bossSchema: z.string().min(1).default("pgboss"),
  /** Concurrent process-event workers spawned per process. */
  concurrency: z.coerce.number().int().min(1).max(64).default(2),
  /** Outbox rows claimed per dispatch transaction. */
  outboxBatchSize: z.coerce.number().int().min(1).max(1000).default(100),
  /** Delay between outbox dispatch passes. */
  outboxPollMs: z.coerce.number().int().min(100).max(60_000).default(1000),
  /** Delay between outbox reconciliation passes. */
  outboxReconcileMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
  /** Artifact-deletion outbox rows processed in one transaction. */
  artifactDeletionBatchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100),
  /** Delay between artifact-deletion outbox passes. */
  artifactDeletionPollMs: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1000),
  /** Reproduction outbox rows claimed per dispatch transaction. */
  reproductionOutboxBatchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100),
  /** Delay between reproduction outbox dispatch passes. */
  reproductionOutboxPollMs: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1000),
  /** Delay between reproduction outbox reconciliation passes. */
  reproductionOutboxReconcileMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
  /** pg-boss retries per process-event job (0 disables retries). */
  jobRetryLimit: z.coerce.number().int().min(0).max(10).default(4),
  /** pg-boss worker poll interval; 500 ms is the pg-boss minimum. */
  jobPollMs: z.coerce.number().int().min(500).max(60_000).default(500),
  /** Expired invitation cleanup rows retired in one transaction (default: 100). */
  invitationCleanupBatchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100),
  /** Delay between expired invitation cleanup passes (default: 60 seconds). */
  invitationCleanupIntervalMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
  /** Raw events and sessions selected per retention transaction. */
  retentionCleanupBatchSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100),
  /** Delay between retention cleanup passes; failures retry on the next tick. */
  retentionCleanupIntervalMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const parsed = workerConfigSchema.safeParse({
    nodeEnv: env["NODE_ENV"],
    environment: env["REPLAYBUG_ENVIRONMENT"],
    databaseUrl: env["REPLAYBUG_DATABASE_URL"] ?? env["DATABASE_URL"],
    logLevel: env["LOG_LEVEL"],
    bossSchema: env["REPLAYBUG_PGBOSS_SCHEMA"],
    concurrency: env["REPLAYBUG_WORKER_CONCURRENCY"],
    outboxBatchSize: env["REPLAYBUG_OUTBOX_BATCH_SIZE"],
    outboxPollMs: env["REPLAYBUG_OUTBOX_POLL_MS"],
    outboxReconcileMs: env["REPLAYBUG_OUTBOX_RECONCILE_MS"],
    artifactDeletionBatchSize: env["REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE"],
    artifactDeletionPollMs: env["REPLAYBUG_ARTIFACT_DELETION_POLL_MS"],
    reproductionOutboxBatchSize:
      env["REPLAYBUG_REPRODUCTION_OUTBOX_BATCH_SIZE"],
    reproductionOutboxPollMs: env["REPLAYBUG_REPRODUCTION_OUTBOX_POLL_MS"],
    reproductionOutboxReconcileMs:
      env["REPLAYBUG_REPRODUCTION_OUTBOX_RECONCILE_MS"],
    jobRetryLimit: env["REPLAYBUG_JOB_RETRY_LIMIT"],
    jobPollMs: env["REPLAYBUG_JOB_POLL_MS"],
    invitationCleanupBatchSize: env["REPLAYBUG_INVITATION_CLEANUP_BATCH_SIZE"],
    invitationCleanupIntervalMs:
      env["REPLAYBUG_INVITATION_CLEANUP_INTERVAL_MS"],
    retentionCleanupBatchSize: env["REPLAYBUG_RETENTION_CLEANUP_BATCH_SIZE"],
    retentionCleanupIntervalMs: env["REPLAYBUG_RETENTION_CLEANUP_INTERVAL_MS"],
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid worker configuration: ${details}`);
  }
  return parsed.data;
}
