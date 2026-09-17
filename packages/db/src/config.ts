import { z } from "zod";

/**
 * Validated database configuration. Callers must go through this schema so
 * a missing or malformed connection string fails fast with a readable
 * message instead of surfacing as an obscure pg connection error.
 */
export const dbConfigSchema = z.object({
  databaseUrl: z.string().min(1, "REPLAYBUG_DATABASE_URL must not be empty"),
  maxConnections: z.number().int().min(1).max(50).default(10),
  connectionTimeoutMs: z.number().int().min(500).max(30000).default(5000),
});

export type DbConfig = z.infer<typeof dbConfigSchema>;

/** Read database configuration from the environment with fail-fast validation. */
export function loadDbConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DbConfig {
  const parsed = dbConfigSchema.safeParse({
    databaseUrl: env["REPLAYBUG_DATABASE_URL"] ?? env["DATABASE_URL"],
    maxConnections:
      env["REPLAYBUG_DB_MAX_CONNECTIONS"] !== undefined
        ? Number(env["REPLAYBUG_DB_MAX_CONNECTIONS"])
        : undefined,
    connectionTimeoutMs:
      env["REPLAYBUG_DB_CONNECTION_TIMEOUT_MS"] !== undefined
        ? Number(env["REPLAYBUG_DB_CONNECTION_TIMEOUT_MS"])
        : undefined,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid database configuration: ${details}`);
  }
  return parsed.data;
}
