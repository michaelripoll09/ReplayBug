import type { AppInstance } from "../instance.js";
import {
  ingestBatch,
  parseAndValidatePublicKey,
  validateBatchRequest,
  validateOrigin,
  verifyIngestKey,
  type IngestError,
} from "../services/ingest.js";

const INGEST_ERROR_CODES = [
  "INVALID_PUBLIC_KEY",
  "REVOKED_PUBLIC_KEY",
  "DISALLOWED_ORIGIN",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "MALFORMED_PAYLOAD",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "UNSUPPORTED_EVENT_TYPE",
] as const;

export interface IngestRouteDeps {
  db: import("@replaybug/db").Database;
}

const errorJson = {
  type: "object",
  required: ["code", "message", "requestId"],
  properties: {
    code: { type: "string", enum: INGEST_ERROR_CODES },
    message: { type: "string" },
    requestId: { type: "string" },
    details: { type: "object" },
  },
} as const;

const successJson = {
  type: "object",
  required: ["accepted", "duplicate", "rejected", "requestId"],
  properties: {
    accepted: { type: "integer", minimum: 0 },
    duplicate: { type: "integer", minimum: 0 },
    rejected: { type: "integer", minimum: 0 },
    requestId: { type: "string" },
  },
} as const;

const batchRequestJson = {
  type: "object",
  required: [
    "protocol_version",
    "sdk_name",
    "sdk_version",
    "session",
    "events",
  ],
  properties: {
    protocol_version: { type: "integer", const: 1 },
    sdk_name: { type: "string" },
    sdk_version: { type: "string" },
    session: { type: "object" },
    events: { type: "array" },
  },
} as const;

/**
 * Ingest route: POST /api/ingest/v1/batch
 * Separate namespace from dashboard API with its own CORS and auth.
 */
export async function registerIngestRoutes(
  app: AppInstance,
  deps: IngestRouteDeps,
): Promise<void> {
  // Ingest-specific CORS: no credentials, specific headers
  await app.register(async (fastify) => {
    fastify.addHook("onRequest", async (request, reply) => {
      // CORS headers for ingest endpoint
      reply.header("Access-Control-Allow-Origin", "*"); // Will be validated by origin check
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type, X-ReplayBug-Key",
      );
      reply.header("Access-Control-Max-Age", "86400");

      if (request.method === "OPTIONS") {
        return reply.status(204).send();
      }
    });
  });

  app.post(
    "/api/ingest/v1/batch",
    {
      schema: {
        tags: ["Ingest"],
        body: batchRequestJson,
        response: {
          200: successJson,
          400: errorJson,
          401: errorJson,
          403: errorJson,
          429: errorJson,
        },
      },
      config: {
        // Increase body limit for batch ingest
        bodyLimit: 1024 * 1024, // 1 MB (we enforce 512 KB in code)
      },
    },
    async (request, reply) => {
      const requestId = request.id as string;
      const startTime = Date.now();

      try {
        // Parse and validate public key from header
        const authHeader = request.headers["x-replaybug-key"] as
          string | undefined;
        const keyInfo = parseAndValidatePublicKey(authHeader);

        if (!keyInfo) {
          throw createError(
            "INVALID_PUBLIC_KEY",
            "Missing or invalid X-ReplayBug-Key header",
            requestId,
            401,
          );
        }

        // Verify key against database
        const keyVerification = await verifyIngestKey(
          deps.db,
          keyInfo.prefix,
          keyInfo.fullKey,
        );
        if (!keyVerification) {
          throw createError(
            "REVOKED_PUBLIC_KEY",
            "Invalid or revoked public key",
            requestId,
            401,
          );
        }

        const { projectId } = keyVerification;

        // Validate origin
        const origin = request.headers.origin as string | undefined;
        const originValid = await validateOrigin(
          deps.db,
          projectId,
          origin || null,
        );
        if (!originValid) {
          throw createError(
            "DISALLOWED_ORIGIN",
            "Origin not allowed for this project",
            requestId,
            403,
          );
        }

        // Validate and parse batch request
        const batch = validateBatchRequest(request.body, requestId);

        // Ingest batch
        const result = await ingestBatch(
          deps.db,
          { projectId, keyPrefix: keyInfo.prefix, requestId },
          batch,
          {
            maxRequestsPerMinute: 60,
            maxEventsPerMinute: 1000,
          },
        );

        // Set Retry-After if rate limited (handled by ingestBatch throwing)
        const duration = Date.now() - startTime;
        console.log(
          `[Ingest] ${requestId} completed in ${duration}ms: accepted=${result.accepted}, duplicate=${result.duplicate}, rejected=${result.rejected}`,
        );

        return reply.status(200).send(result);
      } catch (error) {
        await sendIngestError(request, reply, error as IngestError);
      }
    },
  );
}

function createError(
  code: IngestError["code"],
  message: string,
  requestId: string,
  status: number,
  details?: unknown,
): IngestError {
  const error = new Error(message) as IngestError;
  error.code = code;
  error.status = status;
  error.requestId = requestId;
  error.details = details;
  return error;
}

async function sendIngestError(
  request: unknown,
  reply: unknown,
  error: IngestError,
): Promise<void> {
  const status = error.status || 400;
  const retryAfter = (error.details as Record<string, unknown> | undefined)
    ?.retryAfterSeconds;

  if (retryAfter) {
    (reply as { header: (name: string, value: string) => void }).header(
      "Retry-After",
      String(retryAfter),
    );
  }

  await (
    reply as {
      status: (code: number) => { send: (body: unknown) => Promise<void> };
    }
  )
    .status(status)
    .send({
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      details: error.details,
    });
}

// Re-export for use in service
export { validateOrigin } from "../services/ingest.js";
