import { z } from "zod";

/**
 * Validated API runtime configuration. No scattered `process.env` access is
 * allowed outside this module: every setting is parsed once at startup and
 * the process exits with a human-readable message when required values are
 * missing or malformed.
 */
export const apiConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(4001),
  host: z.string().min(1).default("0.0.0.0"),
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  environment: z.string().min(1).default("development"),
  version: z.string().min(1).default("0.1.0"),
  databaseUrl: z.string().min(1, "REPLAYBUG_DATABASE_URL must not be empty"),
  logLevel: z.string().min(1).default("info"),
  // Optional local Ollama analysis. Disabled by default; presence must never
  // break startup. The AI feature itself arrives in a later block.
  ollamaUrl: z.string().optional(),
  ollamaModel: z.string().optional(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const parsed = apiConfigSchema.safeParse({
    port: env["REPLAYBUG_API_PORT"] ?? env["PORT"],
    host: env["REPLAYBUG_API_HOST"] ?? env["HOST"],
    nodeEnv: env["NODE_ENV"],
    environment: env["REPLAYBUG_ENVIRONMENT"],
    version: env["REPLAYBUG_API_VERSION"] ?? env["npm_package_version"],
    databaseUrl: env["REPLAYBUG_DATABASE_URL"] ?? env["DATABASE_URL"],
    logLevel: env["LOG_LEVEL"],
    ollamaUrl: env["REPLAYBUG_OLLAMA_URL"],
    ollamaModel: env["REPLAYBUG_OLLAMA_MODEL"],
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API configuration: ${details}`);
  }
  return parsed.data;
}
