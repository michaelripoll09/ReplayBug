import { z } from "zod";

const OLLAMA_DEFAULT_TIMEOUT_MS = 30_000;
const OLLAMA_MIN_TIMEOUT_MS = 1_000;
const OLLAMA_MAX_TIMEOUT_MS = 120_000;

export const ollamaCapabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled") }).strict(),
  z
    .object({
      state: z.literal("configured"),
      baseUrl: z.string().url(),
      model: z.string().min(1).max(256),
      timeoutMs: z
        .number()
        .int()
        .min(OLLAMA_MIN_TIMEOUT_MS)
        .max(OLLAMA_MAX_TIMEOUT_MS),
    })
    .strict(),
  z
    .object({
      state: z.literal("misconfigured"),
      code: z.enum([
        "OLLAMA_URL_INVALID",
        "OLLAMA_MODEL_INVALID",
        "OLLAMA_CONFIGURATION_INCOMPLETE",
        "OLLAMA_TIMEOUT_INVALID",
      ]),
      reason: z.string().min(1).max(160),
    })
    .strict(),
]);
export type OllamaCapability = z.infer<typeof ollamaCapabilitySchema>;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function parseOllamaUrl(value: string): string | null {
  if (value.length === 0 || hasControlCharacter(value)) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === ""
    ) {
      return null;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Parses optional, environment-only Ollama configuration without blocking startup. */
export function loadOllamaCapability(env: NodeJS.ProcessEnv): OllamaCapability {
  const rawUrl = env["REPLAYBUG_OLLAMA_URL"];
  const rawModel = env["REPLAYBUG_OLLAMA_MODEL"];
  const rawTimeout = env["REPLAYBUG_OLLAMA_TIMEOUT_MS"];
  const timeout =
    rawTimeout === undefined ? OLLAMA_DEFAULT_TIMEOUT_MS : Number(rawTimeout);

  if (
    rawTimeout !== undefined &&
    (!Number.isInteger(timeout) ||
      timeout < OLLAMA_MIN_TIMEOUT_MS ||
      timeout > OLLAMA_MAX_TIMEOUT_MS)
  ) {
    return {
      state: "misconfigured",
      code: "OLLAMA_TIMEOUT_INVALID",
      reason: "Ollama timeout must be an integer within the supported range.",
    };
  }
  if (rawUrl === undefined && rawModel === undefined) {
    return { state: "disabled" };
  }
  if (rawUrl === undefined || rawModel === undefined) {
    return {
      state: "misconfigured",
      code: "OLLAMA_CONFIGURATION_INCOMPLETE",
      reason: "Ollama URL and model must be configured together.",
    };
  }
  const baseUrl = parseOllamaUrl(rawUrl);
  if (baseUrl === null) {
    return {
      state: "misconfigured",
      code: "OLLAMA_URL_INVALID",
      reason:
        "Ollama URL must be a safe HTTP or HTTPS URL without credentials, query, or fragment.",
    };
  }
  if (hasControlCharacter(rawModel)) {
    return {
      state: "misconfigured",
      code: "OLLAMA_MODEL_INVALID",
      reason: "Ollama model must be a non-empty supported model name.",
    };
  }
  const model = rawModel.trim();
  if (model.length === 0 || model.length > 256) {
    return {
      state: "misconfigured",
      code: "OLLAMA_MODEL_INVALID",
      reason: "Ollama model must be a non-empty supported model name.",
    };
  }
  return { state: "configured", baseUrl, model, timeoutMs: timeout };
}

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
  /** Optional provider capability; invalid optional settings never block startup. */
  ollama: ollamaCapabilitySchema.optional(),
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
    ollama: loadOllamaCapability(env),
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid worker configuration: ${details}`);
  }
  return parsed.data;
}
