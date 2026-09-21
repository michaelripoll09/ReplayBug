import { z } from "zod";
import { sortOrderSchema } from "./issues.js";

/**
 * Block 6 telemetry session/event DTOs.
 *
 * Privacy boundary: raw host identifiers (`sdk_session_id`,
 * `anonymous_user_hash`) and full `payload_json` are never exposed.
 * Event detail carries per-type safe fields only (defined in T07).
 */

/** Session list/detail DTO without raw host IDs. */
export const telemetrySessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  environment: z.string().min(1),
  release: z.string().nullable(),
  startedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  initialUrl: z.string().min(1),
  browserName: z.string().nullable(),
  browserVersion: z.string().nullable(),
  osName: z.string().nullable(),
  osVersion: z.string().nullable(),
  deviceType: z.string().nullable(),
  viewportWidth: z.number().int().nullable(),
  viewportHeight: z.number().int().nullable(),
  sdkVersion: z.string().min(1),
});
export type TelemetrySession = z.infer<typeof telemetrySessionSchema>;

export const sessionListQuerySchema = z.object({
  environment: z.string().trim().min(1).max(100).optional(),
  release: z.string().trim().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  /** When true, only sessions linked to an error occurrence. */
  hasErrors: z.coerce.boolean().optional(),
  order: sortOrderSchema.default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

export const eventProcessingStateSchema = z.enum([
  "pending",
  "processed",
  "rejected",
]);
export type EventProcessingState = z.infer<typeof eventProcessingStateSchema>;

/** Session timeline entry: per-type safe fields, never full payloads. */
export const sessionEventSchema = z.object({
  id: z.string().uuid(),
  sequenceNumber: z.number().int().min(0),
  eventType: z.string().min(1),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  environment: z.string().min(1),
  release: z.string().nullable(),
  pageUrl: z.string().nullable(),
  processingState: eventProcessingStateSchema,
  /** Plain-text one-line evidence derived server-side from the payload. */
  summary: z.string(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).optional(),
});
export type SessionEventsQuery = z.infer<typeof sessionEventsQuerySchema>;

/** Timeline-context window around an occurrence (sequence-based). */
export const timelineContextQuerySchema = z.object({
  before: z.coerce.number().int().min(0).max(100).default(20),
  after: z.coerce.number().int().min(0).max(50).default(5),
});
export type TimelineContextQuery = z.infer<typeof timelineContextQuerySchema>;
