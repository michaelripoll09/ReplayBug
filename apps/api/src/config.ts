import { z } from "zod";
import {
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  PREFLIGHT_MAX_ENTRIES,
  UPLOAD_AGGREGATE_MAX_BYTES,
  isSafeArtifactRoot,
} from "@replaybug/artifacts";

const OLLAMA_MIN_TIMEOUT_MS = 1_000;
const OLLAMA_MAX_TIMEOUT_MS = 120_000;

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

export interface AiAnalysisCapability {
  status: "disabled" | "configured" | "misconfigured";
  configured: boolean;
  model?: string;
}

/** Mirrors the worker's capability semantics without blocking startup. */
export function resolveAiAnalysisCapability(input: {
  ollamaUrl?: string | undefined;
  ollamaModel?: string | undefined;
  ollamaTimeoutMs?: number | undefined;
}): AiAnalysisCapability {
  const { ollamaUrl, ollamaModel, ollamaTimeoutMs } = input;

  if (
    ollamaTimeoutMs !== undefined &&
    (!Number.isInteger(ollamaTimeoutMs) ||
      ollamaTimeoutMs < OLLAMA_MIN_TIMEOUT_MS ||
      ollamaTimeoutMs > OLLAMA_MAX_TIMEOUT_MS)
  ) {
    return { status: "misconfigured", configured: false };
  }
  if (ollamaUrl === undefined && ollamaModel === undefined) {
    return { status: "disabled", configured: false };
  }
  if (ollamaUrl === undefined || ollamaModel === undefined) {
    return { status: "misconfigured", configured: false };
  }
  const baseUrl = parseOllamaUrl(ollamaUrl);
  if (baseUrl === null) {
    return { status: "misconfigured", configured: false };
  }
  const model = ollamaModel.trim();
  if (hasControlCharacter(model) || model.length === 0 || model.length > 256) {
    return { status: "misconfigured", configured: false };
  }
  return { status: "configured", configured: true, model };
}

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
  ollamaTimeoutMs: z.preprocess((value) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (
      !Number.isInteger(parsed) ||
      parsed < OLLAMA_MIN_TIMEOUT_MS ||
      parsed > OLLAMA_MAX_TIMEOUT_MS
    ) {
      return undefined;
    }
    return parsed;
  }, z.number().int().min(OLLAMA_MIN_TIMEOUT_MS).max(OLLAMA_MAX_TIMEOUT_MS).optional()),
  aiAnalysis: z.object({
    status: z.enum(["disabled", "configured", "misconfigured"]),
    configured: z.boolean(),
    model: z.string().optional(),
  }),
  // Block 2 auth boundary. All auth-related env is validated here, fail-fast.
  authSecret: z
    .string()
    .min(32, "REPLAYBUG_AUTH_SECRET must be at least 32 characters"),
  webUrl: z.string().url().default("http://localhost:3000"),
  apiUrl: z.string().url().default("http://localhost:4001"),
  trustedOrigins: z.array(z.string().url()).default([]),
  // Ingest limits
  ingestMaxBatchEvents: z.coerce.number().int().positive().default(50),
  ingestMaxBodyBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024),
  ingestMaxEventBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(128 * 1024),
  ingestRateLimitRequestsPerMinute: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  ingestRateLimitEventsPerMinute: z.coerce
    .number()
    .int()
    .positive()
    .default(1000),
  // User HMAC secret (required for production, min 32 chars)
  userHmacSecret: z
    .string()
    .min(32, "REPLAYBUG_USER_HMAC_SECRET must be at least 32 characters"),
  // RS-06 artifact upload policy (server authoritative). The per-file cap
  // is enforced by HTTP/multipart limits BEFORE unbounded buffering; the
  // manifest/aggregate caps bound preflight. Staging defaults to the OS
  // temp dir; the storage root defaults to REPLAYBUG_ARTIFACT_DIR /
  // ~/.replaybug/artifacts via @replaybug/artifacts.
  //
  // RS-13: an explicit REPLAYBUG_ARTIFACT_DIR is validated here (fail-fast
  // with a readable message) instead of failing later at first upload, so
  // production misconfiguration surfaces at startup. Unset stays valid —
  // the shared @replaybug/artifacts contract supplies the validated
  // OS-local default. The worker shares that same contract via
  // LocalArtifactStorage.fromEnv() but degrades to raw symbolication
  // instead of failing startup (ingest must survive storage outages).
  artifactDir: z
    .string()
    .refine((value) => isSafeArtifactRoot(value), {
      message:
        "REPLAYBUG_ARTIFACT_DIR must be an absolute directory outside repo source trees (or unset for the OS-local default)",
    })
    .optional(),
  artifactMaxFileBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024)
    .default(DEFAULT_ARTIFACT_MAX_FILE_BYTES),
  artifactPreflightMaxEntries: z.coerce
    .number()
    .int()
    .positive()
    .max(5000)
    .default(PREFLIGHT_MAX_ENTRIES),
  artifactAggregateMaxBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(UPLOAD_AGGREGATE_MAX_BYTES),
  artifactStagingDir: z.string().optional(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const rawOllamaUrl = env["REPLAYBUG_OLLAMA_URL"];
  const rawOllamaModel = env["REPLAYBUG_OLLAMA_MODEL"];
  const rawOllamaTimeout = env["REPLAYBUG_OLLAMA_TIMEOUT_MS"];
  const aiAnalysis = resolveAiAnalysisCapability({
    ollamaUrl: rawOllamaUrl,
    ollamaModel: rawOllamaModel,
    ollamaTimeoutMs:
      rawOllamaTimeout === undefined ? undefined : Number(rawOllamaTimeout),
  });

  const rawTrusted = env["REPLAYBUG_TRUSTED_ORIGINS"];
  const parsedTrusted =
    rawTrusted !== undefined && rawTrusted.trim() !== ""
      ? rawTrusted
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  const webUrl = env["REPLAYBUG_WEB_URL"];
  const trustedWithWeb =
    webUrl !== undefined &&
    webUrl.trim() !== "" &&
    !parsedTrusted.includes(webUrl.trim())
      ? [...parsedTrusted, webUrl.trim()]
      : parsedTrusted;
  const parsed = apiConfigSchema.safeParse({
    port: env["REPLAYBUG_API_PORT"] ?? env["PORT"],
    host: env["REPLAYBUG_API_HOST"] ?? env["HOST"],
    nodeEnv: env["NODE_ENV"],
    environment: env["REPLAYBUG_ENVIRONMENT"],
    version: env["REPLAYBUG_API_VERSION"] ?? env["npm_package_version"],
    databaseUrl: env["REPLAYBUG_DATABASE_URL"] ?? env["DATABASE_URL"],
    logLevel: env["LOG_LEVEL"],
    ollamaUrl: rawOllamaUrl,
    ollamaModel: rawOllamaModel,
    ollamaTimeoutMs: rawOllamaTimeout,
    aiAnalysis,
    authSecret: env["REPLAYBUG_AUTH_SECRET"] ?? env["BETTER_AUTH_SECRET"],
    webUrl: env["REPLAYBUG_WEB_URL"],
    apiUrl: env["REPLAYBUG_API_URL"],
    trustedOrigins: trustedWithWeb.length > 0 ? trustedWithWeb : undefined,
    ingestMaxBatchEvents: env["REPLAYBUG_INGEST_MAX_BATCH_EVENTS"],
    ingestMaxBodyBytes: env["REPLAYBUG_INGEST_MAX_BODY_BYTES"],
    ingestMaxEventBytes: env["REPLAYBUG_INGEST_MAX_EVENT_BYTES"],
    ingestRateLimitRequestsPerMinute:
      env["REPLAYBUG_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE"],
    ingestRateLimitEventsPerMinute:
      env["REPLAYBUG_INGEST_RATE_LIMIT_EVENTS_PER_MINUTE"],
    userHmacSecret: env["REPLAYBUG_USER_HMAC_SECRET"],
    artifactDir: env["REPLAYBUG_ARTIFACT_DIR"],
    artifactMaxFileBytes: env["REPLAYBUG_ARTIFACT_MAX_FILE_BYTES"],
    artifactStagingDir: env["REPLAYBUG_ARTIFACT_STAGING_DIR"],
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid API configuration: ${details}`);
  }
  const data = parsed.data;
  // Trusted dashboard origin defaults to the web URL when not configured.
  if (data.trustedOrigins.length === 0) {
    return { ...data, trustedOrigins: [data.webUrl] };
  }
  return data;
}
