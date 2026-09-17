import { z } from "zod";

/**
 * Telemetry protocol version. Single canonical constant.
 * Server accepts only current version, rejects unsupported with UNSUPPORTED_PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Sensitive parameter names that must be redacted from URLs.
 * Values are replaced with [REDACTED].
 */
export const SENSITIVE_URL_PARAMS = [
  "token",
  "access_token",
  "refresh_token",
  "key",
  "api_key",
  "password",
  "secret",
  "auth",
  "code",
  "client_secret",
  "client_id",
  "authorization",
  "bearer",
  "jwt",
  "session_id",
  "sessionid",
  "sid",
  "csrf",
  "xsrf",
  "_token",
] as const;

/**
 * Maximum payload constraints (server-enforced, client should respect).
 */
export const TELEMETRY_LIMITS = {
  MAX_BATCH_EVENTS: 50,
  MAX_BODY_BYTES: 512 * 1024, // 512 KB
  MAX_EVENT_BYTES: 128 * 1024, // 128 KB
  MAX_MESSAGE_LENGTH: 8 * 1024, // 8 KB
  MAX_STACK_FRAMES: 100,
  MAX_BREADCRUMBS: 50,
  MAX_CONTEXT_DEPTH: 6,
} as const;

/**
 * Event types supported by the telemetry protocol.
 */
export const eventTypeSchema = z.enum([
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
]);

export type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Stack frame schema (explicit, no Record<string, any>).
 */
export const stackFrameSchema = z.object({
  filename: z.string().max(512).optional(),
  function: z.string().max(256).optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  in_app: z.boolean().optional(),
  abs_path: z.string().max(1024).optional(),
  context: z.record(z.string(), z.string().max(256)).optional(),
});

export type StackFrame = z.infer<typeof stackFrameSchema>;

/**
 * Exception value schema.
 */
export const exceptionValueSchema = z.object({
  type: z.string().max(256),
  value: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH),
  module: z.string().max(256).optional(),
  stacktrace: z
    .object({
      frames: z.array(stackFrameSchema).max(TELEMETRY_LIMITS.MAX_STACK_FRAMES),
    })
    .optional(),
  mechanism: z
    .object({
      type: z.string().max(64),
      handled: z.boolean(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type ExceptionValue = z.infer<typeof exceptionValueSchema>;

/**
 * Exception event payload.
 */
export const exceptionEventPayloadSchema = z.object({
  values: z.array(exceptionValueSchema).min(1).max(10),
  mechanism: z
    .object({
      type: z.string().max(64),
      handled: z.boolean(),
      data: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export type ExceptionEventPayload = z.infer<typeof exceptionEventPayloadSchema>;

/**
 * Unhandled rejection event payload.
 */
export const unhandledRejectionEventPayloadSchema = z.object({
  reason: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH),
  promise: z.string().max(512).optional(),
});

export type UnhandledRejectionEventPayload = z.infer<
  typeof unhandledRejectionEventPayloadSchema
>;

/**
 * Console error event payload.
 */
export const consoleErrorEventPayloadSchema = z.object({
  args: z.array(z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH)).max(10),
});

export type ConsoleErrorEventPayload = z.infer<
  typeof consoleErrorEventPayloadSchema
>;

/**
 * Network event payload.
 */
export const networkEventPayloadSchema = z.object({
  url: z.string().url().max(2048),
  method: z.string().max(16),
  status_code: z.number().int().min(0).max(999).nullable(),
  duration_ms: z.number().int().nonnegative(),
  request_started_at: z.string().datetime(),
  failure_type: z
    .enum(["network_error", "http_error", "timeout", "aborted", "unknown"])
    .optional(),
  status_text: z.string().max(128).optional(),
});

export type NetworkEventPayload = z.infer<typeof networkEventPayloadSchema>;

/**
 * Navigation event payload.
 */
export const navigationEventPayloadSchema = z.object({
  from_url: z.string().url().max(2048).nullable(),
  to_url: z.string().url().max(2048),
  navigation_type: z.enum([
    "pushState",
    "replaceState",
    "popstate",
    "hashchange",
    "full_reload",
  ]),
});

export type NavigationEventPayload = z.infer<
  typeof navigationEventPayloadSchema
>;

/**
 * Click event payload.
 */
export const clickEventPayloadSchema = z.object({
  locator_candidates: z
    .array(
      z.object({
        type: z.enum(["test_id", "role_name", "id", "name", "css_fallback"]),
        value: z.string().max(512),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(5),
  element_tag: z.string().max(64),
  element_role: z.string().max(64).optional(),
  accessible_name: z.string().max(128).optional(),
  route: z.string().max(512).optional(),
});

export type ClickEventPayload = z.infer<typeof clickEventPayloadSchema>;

/**
 * Input event payload.
 */
export const inputEventPayloadSchema = z.object({
  input_type: z.string().max(64),
  input_name: z.string().max(128).optional(),
  input_id: z.string().max(128).optional(),
  has_value: z.boolean(),
  value: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH).optional(),
  is_safe_selector_match: z.boolean(),
});

export type InputEventPayload = z.infer<typeof inputEventPayloadSchema>;

/**
 * Message event payload (captureMessage).
 */
export const messageEventPayloadSchema = z.object({
  message: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH),
  level: z
    .enum(["debug", "info", "warning", "error", "critical"])
    .default("info"),
});

export type MessageEventPayload = z.infer<typeof messageEventPayloadSchema>;

/**
 * Custom breadcrumb event payload.
 */
export const customBreadcrumbEventPayloadSchema = z.object({
  category: z.string().max(64),
  message: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH),
  data: z.record(z.string(), z.unknown()).optional(),
  level: z
    .enum(["debug", "info", "warning", "error", "critical"])
    .default("info"),
  type: z.literal("custom"),
});

export type CustomBreadcrumbEventPayload = z.infer<
  typeof customBreadcrumbEventPayloadSchema
>;

/**
 * SDK lifecycle event payload.
 */
export const sdkEventPayloadSchema = z.object({
  sdk_name: z.string().max(64),
  sdk_version: z.string().max(32),
  event: z.enum(["init", "close", "flush", "config_change"]),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export type SdkEventPayload = z.infer<typeof sdkEventPayloadSchema>;

/**
 * Browser metadata schema.
 */
export const browserMetadataSchema = z.object({
  name: z.string().max(64).nullable(),
  version: z.string().max(64).nullable(),
  os_name: z.string().max(64).nullable(),
  os_version: z.string().max(64).nullable(),
  device_type: z
    .enum(["desktop", "mobile", "tablet", "unknown"])
    .default("unknown"),
  viewport_width: z.number().int().nonnegative().nullable(),
  viewport_height: z.number().int().nonnegative().nullable(),
  user_agent: z.string().max(512).optional(),
});

export type BrowserMetadata = z.infer<typeof browserMetadataSchema>;

/**
 * Telemetry session metadata (sent with first event or init).
 */
export const sessionMetadataSchema = z.object({
  sdk_session_id: z.string().uuid(),
  browser: browserMetadataSchema,
  initial_url: z.string().url().max(2048),
  release: z.string().max(128).optional(),
  environment: z.string().max(64).optional(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
});

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

/**
 * Breadcrumb schema (client-side ring buffer item).
 */
export const breadcrumbSchema = z.object({
  timestamp: z.string().datetime(),
  type: z.enum([
    "navigation",
    "click",
    "input",
    "network",
    "console",
    "custom",
    "sdk",
  ]),
  category: z.string().max(64).optional(),
  message: z.string().max(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  level: z
    .enum(["debug", "info", "warning", "error", "critical"])
    .default("info"),
  event_type: z.string().max(64).optional(),
  payload: z.unknown().optional(),
});

export type Breadcrumb = z.infer<typeof breadcrumbSchema>;

/**
 * Context entry schema (for structured context).
 */
export const contextEntrySchema = z.object({
  key: z.string().max(128),
  value: z.unknown(),
});

export type ContextEntry = z.infer<typeof contextEntrySchema>;

/**
 * Event envelope schema (discriminated union for all event types).
 */
export const baseEventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: eventTypeSchema,
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
});

export type BaseEventEnvelope = z.infer<typeof baseEventEnvelopeSchema>;

/**
 * Discriminated union for all event envelope types.
 * Each variant explicitly defines the full schema to satisfy Zod 4 discriminatedUnion.
 */
const exceptionEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("exception"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: exceptionEventPayloadSchema,
});

const unhandledRejectionEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("unhandled_rejection"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: unhandledRejectionEventPayloadSchema,
});

const consoleErrorEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("console_error"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: consoleErrorEventPayloadSchema,
});

const networkEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("network"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: networkEventPayloadSchema,
});

const navigationEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("navigation"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: navigationEventPayloadSchema,
});

const clickEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("click"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: clickEventPayloadSchema,
});

const inputEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("input"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: inputEventPayloadSchema,
});

const messageEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("message"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: messageEventPayloadSchema,
});

const customBreadcrumbEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("custom_breadcrumb"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: customBreadcrumbEventPayloadSchema,
});

const sdkEventSchema = z.object({
  event_id: z.string().uuid(),
  sequence_number: z.number().int().nonnegative(),
  event_type: z.literal("sdk"),
  timestamp: z.string().datetime(),
  tags: z.record(z.string(), z.string().max(128)).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z
    .array(breadcrumbSchema)
    .max(TELEMETRY_LIMITS.MAX_BREADCRUMBS)
    .optional(),
  payload: sdkEventPayloadSchema,
});

export const eventEnvelopeSchema = z.discriminatedUnion("event_type", [
  exceptionEventSchema,
  unhandledRejectionEventSchema,
  consoleErrorEventSchema,
  networkEventSchema,
  navigationEventSchema,
  clickEventSchema,
  inputEventSchema,
  messageEventSchema,
  customBreadcrumbEventSchema,
  sdkEventSchema,
]);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Batch ingest request schema.
 */
export const batchIngestRequestSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  sdk_name: z.string().max(64),
  sdk_version: z.string().max(32),
  session: sessionMetadataSchema,
  events: z
    .array(eventEnvelopeSchema)
    .min(1)
    .max(TELEMETRY_LIMITS.MAX_BATCH_EVENTS),
});

export type BatchIngestRequest = z.infer<typeof batchIngestRequestSchema>;

/**
 * Batch ingest response schema.
 */
export const batchIngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  request_id: z.string().uuid(),
});

export type BatchIngestResponse = z.infer<typeof batchIngestResponseSchema>;

/**
 * Ingest error codes.
 */
export const ingestErrorCodeSchema = z.enum([
  "INVALID_PUBLIC_KEY",
  "REVOKED_PUBLIC_KEY",
  "DISALLOWED_ORIGIN",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "MALFORMED_PAYLOAD",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "UNSUPPORTED_EVENT_TYPE",
]);

export type IngestErrorCode = z.infer<typeof ingestErrorCodeSchema>;

/**
 * Ingest error response schema.
 */
export const ingestErrorResponseSchema = z.object({
  code: ingestErrorCodeSchema,
  message: z.string(),
  request_id: z.string().uuid(),
  details: z.unknown().optional(),
});

export type IngestErrorResponse = z.infer<typeof ingestErrorResponseSchema>;

/**
 * DSN parsing result.
 */
export const dsnParseResultSchema = z.object({
  publicKey: z.string().min(1),
  baseUrl: z.string().url(),
  projectId: z.string().optional(),
});

export type DsnParseResult = z.infer<typeof dsnParseResultSchema>;

/**
 * Ingest rate limit bucket schema.
 */
export const rateLimitBucketSchema = z.object({
  project_id: z.string().uuid(),
  key_prefix: z.string(),
  bucket_start: z.string().datetime(),
  request_count: z.number().int().nonnegative(),
  event_count: z.number().int().nonnegative(),
});

export type RateLimitBucket = z.infer<typeof rateLimitBucketSchema>;

/**
 * Ingest rate limit configuration.
 */
export const ingestRateLimitConfigSchema = z.object({
  requests_per_minute: z.number().int().positive().default(60),
  events_per_minute: z.number().int().positive().default(1000),
});

export type IngestRateLimitConfig = z.infer<typeof ingestRateLimitConfigSchema>;
