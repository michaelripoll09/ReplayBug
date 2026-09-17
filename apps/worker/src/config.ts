import { z } from "zod";

/**
 * Validated worker runtime configuration. Fails fast with a human-readable
 * message when required values are missing so misconfiguration surfaces at
 * startup instead of as a silent idle worker.
 */
export const workerConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  environment: z.string().min(1).default("development"),
  databaseUrl: z.string().min(1, "REPLAYBUG_DATABASE_URL must not be empty"),
  logLevel: z.string().min(1).default("info"),
  // pg-boss schema/table settings reserved for the future job wiring.
  // Parsed now so operator mistakes fail fast even before jobs exist.
  bossSchema: z.string().min(1).default("pgboss"),
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
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid worker configuration: ${details}`);
  }
  return parsed.data;
}
