import rateLimit from "@fastify/rate-limit";
import type { ApiConfig } from "../config.js";
import type { AppInstance } from "../instance.js";

/**
 * Coarse outer API rate limiter (DoS guard).
 *
 * Official `@fastify/rate-limit` registered globally against the same
 * Fastify instance that owns the routes. Semantics:
 * - global: true, evaluated at the early `onRequest` stage
 * - in-memory store (no Redis)
 * - fail closed on limiter errors (`skipOnError: false`)
 * - default key behavior: the plugin's standard IP normalization
 *   (`request.ip`, IPv6-subnet aware). ReplayBug never trusts
 *   X-Forwarded-For manually and does not enable `trustProxy` here.
 *
 * The 1000 req / 60 s outer policy is intentionally looser than the
 * specialized limiters, which stay authoritative for their own quotas:
 * - ingest keeps its PostgreSQL-backed per-project/key request+event
 *   buckets (`services/ingest.ts`)
 * - Better Auth keeps its own 100 req / 60 s auth limiter (`auth.ts`)
 */

/** Outer default: 1000 requests per 60 seconds per observed client IP. */
export const GLOBAL_RATE_LIMIT_MAX = 1000;
export const GLOBAL_RATE_LIMIT_WINDOW = "1 minute";

/** 429 envelope code for the global limiter. */
export const GLOBAL_RATE_LIMIT_CODE = "RATE_LIMITED";

/**
 * Strict per-route overrides for clearly expensive or security-sensitive
 * operations. Ordinary reads stay on the global default. Each policy is
 * applied via `config: { rateLimit: ... }` on the owning route so the
 * route-specific limit binds before the coarse 1000/min outer limit.
 */
export const RATE_LIMIT_POLICIES = {
  /** LLM-backed analysis creation is slow and provider-billed. */
  aiAnalysisCreate: { max: 10, timeWindow: "1 minute" },
  /** Playwright reproduction generation is CPU-heavy per request. */
  reproductionCreate: { max: 20, timeWindow: "1 minute" },
  /** Secret-token create/revoke mints or kills automation credentials. */
  secretTokenMutation: { max: 20, timeWindow: "1 minute" },
  /** Invitation create/revoke/accept mints or consumes access grants. */
  invitationMutation: { max: 30, timeWindow: "1 minute" },
  /** CLI artifact upload stages, hashes, and validates file bytes. */
  cliArtifactUpload: { max: 30, timeWindow: "1 minute" },
  /** Issue lifecycle mutations (status/assignee) change triage state. */
  issueMutation: { max: 60, timeWindow: "1 minute" },
} as const;

export interface RateLimitRegistrationOptions {
  /**
   * Test seam for the focused limiter suite: a small `max`/short
   * `timeWindow` exercises the real 429 path without sending 1000+
   * requests. Production wiring always uses the exported global
   * constants above. Never set from runtime configuration.
   */
  max?: number;
  timeWindow?: string | number;
}

function resolveRequestId(request: {
  id: unknown;
  requestId?: unknown;
}): string {
  // Prefer the ReplayBug request ID (validated incoming `x-request-id` or
  // generated, already echoed on the response by the request-id hook) so
  // the 429 envelope correlates with every other error envelope and with
  // the `x-request-id` header. Fall back to the transport request id.
  // Neither value exposes IPs, limiter keys, cookies, or tokens.
  if (typeof request.requestId === "string" && request.requestId.length > 0) {
    return request.requestId;
  }
  return typeof request.id === "string" ? request.id : "unknown";
}

export async function registerRateLimit(
  app: AppInstance,
  config: Pick<ApiConfig, "nodeEnv">,
  overrides?: RateLimitRegistrationOptions,
): Promise<void> {
  // The plugin stays REGISTERED in every environment (including test) so
  // the global security architecture remains visible to static analysis.
  // In test mode only, consumption is bypassed via allowList so suites
  // that inject hundreds of requests from one process/IP stay stable.
  const testBypass = config.nodeEnv === "test";
  await app.register(rateLimit, {
    global: true,
    hook: "onRequest",
    max: overrides?.max ?? GLOBAL_RATE_LIMIT_MAX,
    timeWindow: overrides?.timeWindow ?? GLOBAL_RATE_LIMIT_WINDOW,
    // Fail closed: a broken store must block traffic, never open it.
    skipOnError: false,
    allowList: () => testBypass,
    errorResponseBuilder: (request, _context) => ({
      statusCode: 429,
      code: GLOBAL_RATE_LIMIT_CODE,
      message: "Too many requests. Try again later.",
      requestId: resolveRequestId(request),
    }),
  });
}
