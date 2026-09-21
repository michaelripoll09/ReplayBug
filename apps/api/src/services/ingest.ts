import {
  verifyPublicKey,
  findKeyByPrefix,
  listOriginsByProject,
  deriveAnonymousUserHash,
} from "@replaybug/db";
import {
  PROTOCOL_VERSION,
  TELEMETRY_LIMITS,
  type BatchIngestRequest,
  type IngestErrorCode,
} from "@replaybug/contracts";
import type { Database, DbTransaction } from "@replaybug/db";
import {
  sanitizeBatchRequest,
  sanitizeContext,
  sanitizeEventPayload,
  sanitizeUrl,
  upsertTelemetrySession,
  insertEvent,
  eventExists,
  insertOutbox,
  checkAndIncrementRateLimit,
} from "@replaybug/db";

/**
 * Ingest service - handles public telemetry ingestion
 */

export interface IngestContext {
  projectId: string;
  keyPrefix: string;
  requestId: string;
}

export interface IngestResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  requestId: string;
}

export interface IngestError extends Error {
  code: IngestErrorCode;
  status: number;
  requestId: string;
  details?: unknown;
}

/**
 * Create an ingest error
 */
function createIngestError(
  code: IngestErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
  status = 400,
): IngestError {
  const error = new Error(message) as IngestError;
  error.code = code;
  error.status = status;
  error.requestId = requestId;
  error.details = details;
  return error;
}

/**
 * Validate and parse public key from header
 */
export function parseAndValidatePublicKey(
  authHeader: string | undefined,
): { prefix: string; fullKey: string } | null {
  if (!authHeader) return null;

  // Format: "Bearer <key>" or just "<key>"
  const key = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  if (!key.startsWith("rb_pk_")) return null;

  return { prefix: key.split("_")[2] || "", fullKey: key };
}

/**
 * Verify public key against database
 */
export async function verifyIngestKey(
  db: Database,
  prefix: string,
  fullKey: string,
): Promise<{ projectId: string; keyId: string } | null> {
  const keyRow = await findKeyByPrefix(db, prefix);
  if (!keyRow) return null;
  if (keyRow.revokedAt) return null;
  if (keyRow.kind !== "public_ingest") return null;

  const valid = verifyPublicKey(fullKey, keyRow.keyHash);
  if (!valid) return null;

  return { projectId: keyRow.projectId, keyId: keyRow.id };
}

/**
 * Validate origin against project allowed origins.
 *
 * Exact string match only: no wildcards, no port relaxation, no scheme
 * relaxation. A configured origin authorizes that exact origin and nothing
 * else (http vs https, host variants and ports are all distinct).
 */
export async function validateOrigin(
  db: Database,
  projectId: string,
  origin: string | null,
): Promise<boolean> {
  if (!origin) return false;

  const origins = await listOriginsByProject(db, projectId);
  const enabledOrigins = origins
    .filter((o: { isEnabled: boolean; origin: string }) => o.isEnabled)
    .map((o: { origin: string }) => o.origin);

  return enabledOrigins.includes(origin);
}

/**
 * Check rate limits
 */
export async function checkRateLimit(
  db: Database,
  projectId: string,
  keyPrefix: string,
  eventCount: number,
  maxRequestsPerMinute: number,
  maxEventsPerMinute: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number | null }> {
  const result = await checkAndIncrementRateLimit(
    db,
    projectId,
    keyPrefix,
    maxRequestsPerMinute,
    maxEventsPerMinute,
    eventCount,
  );
  return {
    allowed: result.allowed,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

export interface BatchValidationLimits {
  maxBatchEvents: number;
  maxEventBytes: number;
  maxBodyBytes: number;
}

/**
 * Validate batch request
 */
export function validateBatchRequest(
  body: unknown,
  requestId: string,
  limits: BatchValidationLimits = {
    maxBatchEvents: TELEMETRY_LIMITS.MAX_BATCH_EVENTS,
    maxEventBytes: TELEMETRY_LIMITS.MAX_EVENT_BYTES,
    maxBodyBytes: TELEMETRY_LIMITS.MAX_BODY_BYTES,
  },
): BatchIngestRequest {
  if (!body || typeof body !== "object") {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Request body must be a JSON object",
      requestId,
    );
  }

  // Enforce the body size limit explicitly. The transport-level parser limit
  // is the first line of defense; this check keeps the guarantee wherever the
  // body has already been parsed (e.g. embedded/injected transports).
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bodyBytes > limits.maxBodyBytes) {
    throw createIngestError(
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds the maximum size of ${limits.maxBodyBytes} bytes`,
      requestId,
      { received: bodyBytes, max: limits.maxBodyBytes },
      413,
    );
  }

  const batch = body as Record<string, unknown>;

  // Check protocol version
  if (batch.protocol_version !== PROTOCOL_VERSION) {
    throw createIngestError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      `Unsupported protocol version. Expected ${PROTOCOL_VERSION}`,
      requestId,
      { received: batch.protocol_version },
    );
  }

  // Check events array
  if (!batch.events || !Array.isArray(batch.events)) {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Missing or invalid events array",
      requestId,
    );
  }

  if (batch.events.length === 0) {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Events array cannot be empty",
      requestId,
    );
  }

  if (batch.events.length > limits.maxBatchEvents) {
    throw createIngestError(
      "PAYLOAD_TOO_LARGE",
      `Too many events in batch. Maximum ${limits.maxBatchEvents}`,
      requestId,
      { received: batch.events.length, max: limits.maxBatchEvents },
      413,
    );
  }

  // Validate session
  if (!batch.session || typeof batch.session !== "object") {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Missing or invalid session metadata",
      requestId,
    );
  }

  const session = batch.session as Record<string, unknown>;
  if (!session.sdk_session_id || typeof session.sdk_session_id !== "string") {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Missing or invalid sdk_session_id",
      requestId,
    );
  }

  if (!session.initial_url || typeof session.initial_url !== "string") {
    throw createIngestError(
      "MALFORMED_PAYLOAD",
      "Missing or invalid initial_url",
      requestId,
    );
  }

  // Validate each event
  for (let i = 0; i < batch.events.length; i++) {
    const event = batch.events[i];
    if (!event || typeof event !== "object") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} is not an object`,
        requestId,
      );
    }

    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (eventBytes > limits.maxEventBytes) {
      throw createIngestError(
        "PAYLOAD_TOO_LARGE",
        `Event at index ${i} exceeds maximum size of ${limits.maxEventBytes} bytes`,
        requestId,
        { index: i, received: eventBytes, max: limits.maxEventBytes },
        413,
      );
    }

    const e = event as Record<string, unknown>;
    if (!e.event_id || typeof e.event_id !== "string") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} missing event_id`,
        requestId,
      );
    }

    if (typeof e.sequence_number !== "number") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} missing sequence_number`,
        requestId,
      );
    }

    if (!e.event_type || typeof e.event_type !== "string") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} missing event_type`,
        requestId,
      );
    }

    // Validate event type
    const validTypes = [
      "exception",
      "unhandled_rejection",
      "console_error",
      "network",
      "navigation",
      "click",
      "input",
      "message",
      "custom_breadcrumb",
      "sdk",
    ];
    if (!validTypes.includes(e.event_type)) {
      throw createIngestError(
        "UNSUPPORTED_EVENT_TYPE",
        `Event at index ${i} has unsupported event_type: ${e.event_type}`,
        requestId,
      );
    }

    if (!e.timestamp || typeof e.timestamp !== "string") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} missing timestamp`,
        requestId,
      );
    }

    if (!e.payload || typeof e.payload !== "object") {
      throw createIngestError(
        "MALFORMED_PAYLOAD",
        `Event at index ${i} missing payload`,
        requestId,
      );
    }
  }

  return batch as BatchIngestRequest;
}

/**
 * Process a batch of events
 */
export async function ingestBatch(
  db: Database,
  context: IngestContext,
  batch: BatchIngestRequest,
  config: {
    maxRequestsPerMinute: number;
    maxEventsPerMinute: number;
    userHmacSecret: string;
  },
): Promise<IngestResult> {
  const { projectId, keyPrefix, requestId } = context;
  const { session, events } = batch;

  // Check rate limits
  const rateLimit = await checkRateLimit(
    db,
    projectId,
    keyPrefix,
    events.length,
    config.maxRequestsPerMinute,
    config.maxEventsPerMinute,
  );
  if (!rateLimit.allowed) {
    throw createIngestError(
      "RATE_LIMITED",
      "Rate limit exceeded",
      requestId,
      { retryAfterSeconds: rateLimit.retryAfterSeconds },
      429,
    );
  }

  // Apply server-side sanitization to entire batch
  const sanitizedBatch = sanitizeBatchRequest({
    protocol_version: batch.protocol_version,
    sdk_name: batch.sdk_name,
    sdk_version: batch.sdk_version,
    session: {
      ...session,
      initial_url: sanitizeUrl(session.initial_url),
    },
    events: events.map((e) => ({
      ...e,
      context: e.context ? sanitizeContext(e.context) : undefined,
      payload: e.payload ? sanitizeEventPayload(e.payload) : undefined,
    })),
  }) as BatchIngestRequest;

  // Derive anonymous user hash if user_id is present in session
  let anonymousUserHash: string | null = null;
  const rawUserId = sanitizedBatch.session.user_id;
  if (rawUserId) {
    try {
      anonymousUserHash = deriveAnonymousUserHash({
        projectId,
        rawUserId,
        secret: config.userHmacSecret,
      });
    } catch (error) {
      // Log but don't fail the request - we can still process without user hash
      console.warn(`[Ingest] Failed to derive anonymous user hash: ${error}`);
    }
  }

  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;

  // Process each event in a transaction
  for (const event of sanitizedBatch.events) {
    try {
      await db.transaction(async (tx: DbTransaction) => {
        // Upsert telemetry session
        const telemetrySession = await upsertTelemetrySession(tx, {
          projectId,
          sdkSessionId: sanitizedBatch.session.sdk_session_id,
          anonymousUserHash,
          environment: sanitizedBatch.session.environment || "unknown",
          release: sanitizedBatch.session.release || null,
          initialUrl: sanitizedBatch.session.initial_url,
          browserName: sanitizedBatch.session.browser?.name || null,
          browserVersion: sanitizedBatch.session.browser?.version || null,
          osName: sanitizedBatch.session.browser?.os_name || null,
          osVersion: sanitizedBatch.session.browser?.os_version || null,
          deviceType: sanitizedBatch.session.browser?.device_type || null,
          viewportWidth: sanitizedBatch.session.browser?.viewport_width || null,
          viewportHeight:
            sanitizedBatch.session.browser?.viewport_height || null,
          sdkVersion: sanitizedBatch.sdk_version,
        });

        // Check idempotency
        const exists = await eventExists(tx, projectId, event.event_id);
        if (exists) {
          duplicate++;
          return; // Don't insert duplicate, but transaction succeeds
        }

        // Insert event
        const insertedEvent = await insertEvent(tx, {
          projectId,
          telemetrySessionId: telemetrySession.id,
          clientEventId: event.event_id,
          sequenceNumber: event.sequence_number,
          eventType: event.event_type,
          occurredAt: new Date(event.timestamp),
          environment: sanitizedBatch.session.environment || "unknown",
          release: sanitizedBatch.session.release || null,
          pageUrl:
            event.payload &&
            typeof event.payload === "object" &&
            "page_url" in event.payload
              ? String((event.payload as Record<string, unknown>).page_url)
              : sanitizedBatch.session.initial_url,
          payloadJson: event.payload,
        });

        if (!insertedEvent) {
          duplicate++;
          return;
        }

        // Insert outbox row
        await insertOutbox(tx, insertedEvent.id);
        accepted++;
      });
    } catch (error) {
      rejected++;
      // Log error but continue processing other events
      console.error(`[Ingest] Event ${event.event_id} failed:`, error);
    }
  }

  return { accepted, duplicate, rejected, requestId };
}
