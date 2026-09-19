import { z } from "zod";
import { eventProcessingStateSchema } from "./sessions.js";

/**
 * Block 6 occurrence + event-detail DTOs.
 *
 * Occurrences carry linkage and envelope metadata only — never full
 * payloads. Event detail carries explicit per-type safe fields picked from
 * the already-sanitized stored payload: arbitrary `data`/`detail` bags,
 * mechanism internals, fingerprint overrides and input values are dropped
 * by the service mapper (never by the client).
 */

/** One issue occurrence: envelope metadata without the payload. */
export const occurrenceSchema = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  environment: z.string().min(1),
  release: z.string().nullable(),
  pageUrl: z.string().nullable(),
  eventType: z.string().min(1),
  processingState: eventProcessingStateSchema,
});
export type Occurrence = z.infer<typeof occurrenceSchema>;

export const occurrenceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type OccurrenceListQuery = z.infer<typeof occurrenceListQuerySchema>;

/**
 * RS-08 worker source-map enrichment (persisted as JSONB on the event,
 * exposed on the DTO in RS-10). Statuses mirror the worker's internal
 * result: full/partial mapping plus the exact degradation cause.
 * `rawFrames` echoes ingested coordinates verbatim; `mappedFrames` carries
 * the symbolicated view (`mapped: false` entries preserve raw coordinates
 * and never fabricate a source). Storage keys are never part of this shape.
 */
export const eventSymbolicationStatusSchema = z.enum([
  "mapped",
  "partially_mapped",
  "no_release",
  "release_not_found",
  "map_not_found",
  "invalid_map",
  "storage_unavailable",
]);
export type EventSymbolicationStatus = z.infer<
  typeof eventSymbolicationStatusSchema
>;

const symbolicationRawFrameSchema = z.object({
  filename: z.string(),
  function: z.string(),
  lineno: z.number().int().nonnegative(),
  colno: z.number().int().nonnegative(),
  inApp: z.boolean(),
});

const symbolicationMappedFrameSchema = z.object({
  filename: z.string(),
  source: z.string(),
  function: z.string(),
  name: z.string().nullable(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  inApplication: z.boolean(),
  mapped: z.boolean(),
});

export const eventSymbolicationSchema = z.object({
  status: eventSymbolicationStatusSchema,
  rawFrames: z.array(symbolicationRawFrameSchema),
  mappedFrames: z.array(symbolicationMappedFrameSchema),
  mappedFrameCount: z.number().int().nonnegative(),
});
export type EventSymbolication = z.infer<typeof eventSymbolicationSchema>;

/**
 * RS-10 dashboard diagnostic derived from the persisted worker enrichment.
 * `symbolicationStatus` echoes the persisted status (`null` when the event
 * was never symbolicated); `mappedFrames` is the symbolicated view (`null`
 * when no map applied); `rawFrames` always carries the generated-location
 * view (worker echo, else the ingested stack); `preferredStack` is the
 * default view (`mappedFrames ?? rawFrames`). Every frame is built
 * field-by-field from known keys — never an arbitrary DB JSON dump.
 */
const diagnosticRawFrameSchema = z.object({
  filename: z.string().optional(),
  function: z.string().optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  inApp: z.boolean().optional(),
});
export type DiagnosticRawFrame = z.infer<typeof diagnosticRawFrameSchema>;

const diagnosticMappedFrameSchema = z.object({
  filename: z.string(),
  source: z.string(),
  function: z.string(),
  name: z.string().nullable(),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  inApplication: z.boolean(),
  mapped: z.boolean(),
});
export type DiagnosticMappedFrame = z.infer<typeof diagnosticMappedFrameSchema>;

export const eventDiagnosticSchema = z.object({
  symbolicationStatus: eventSymbolicationStatusSchema.nullable(),
  rawFrames: z.array(diagnosticRawFrameSchema),
  mappedFrames: z.array(diagnosticMappedFrameSchema).nullable(),
  preferredStack: z.array(
    z.union([diagnosticRawFrameSchema, diagnosticMappedFrameSchema]),
  ),
});
export type EventDiagnostic = z.infer<typeof eventDiagnosticSchema>;

const eventBaseSchema = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string().uuid(),
  issueId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  environment: z.string().min(1),
  release: z.string().nullable(),
  pageUrl: z.string().nullable(),
  processingState: eventProcessingStateSchema,
  /**
   * RS-08 forward-compat: worker source-map enrichment persisted as JSONB
   * beside the immutable ingest payload. The API populates this from RS-10
   * on (validated worker JSON only); the field stays optional so older
   * payloads validate unchanged. Clients must never submit it (ingest
   * strips it).
   */
  symbolication: eventSymbolicationSchema.optional(),
  /**
   * RS-10 dashboard diagnostic: `{ symbolicationStatus, preferredStack
   * (= mapped ?? raw), rawFrames, mappedFrames nullable }`. Always populated
   * by the API when serving event detail; optional in the contract so
   * previously captured payloads still validate.
   */
  diagnostic: eventDiagnosticSchema.optional(),
});

const safeFrameSchema = z.object({
  filename: z.string().optional(),
  function: z.string().optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
  inApp: z.boolean().optional(),
});
export type SafeFrame = z.infer<typeof safeFrameSchema>;

const exceptionDataSchema = z.object({
  values: z.array(
    z.object({
      type: z.string(),
      value: z.string(),
      stacktrace: z.object({ frames: z.array(safeFrameSchema) }).optional(),
    }),
  ),
});

const rejectionDataSchema = z.object({ reason: z.string() });
const consoleDataSchema = z.object({ args: z.array(z.string()) });
const networkDataSchema = z.object({
  url: z.string(),
  method: z.string(),
  statusCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  failureType: z.string().optional(),
});
const messageDataSchema = z.object({
  message: z.string(),
  level: z.string(),
});
const navigationDataSchema = z.object({
  fromUrl: z.string().nullable(),
  toUrl: z.string(),
  navigationType: z.string(),
});
const clickDataSchema = z.object({
  locatorCandidates: z.array(
    z.object({
      type: z.string(),
      value: z.string(),
      confidence: z.number(),
    }),
  ),
  elementTag: z.string(),
  elementRole: z.string().optional(),
  accessibleName: z.string().optional(),
  route: z.string().optional(),
});
/** Input values are never exposed, even when safely captured. */
const inputDataSchema = z.object({
  inputType: z.string(),
  inputName: z.string().optional(),
  hasValue: z.boolean(),
});
/** Arbitrary breadcrumb `data` bags are never exposed. */
const breadcrumbDataSchema = z.object({
  category: z.string(),
  message: z.string(),
  level: z.string(),
});
/** SDK `detail` bags are never exposed. */
const sdkDataSchema = z.object({
  sdkName: z.string(),
  sdkVersion: z.string(),
  event: z.string(),
});

export const exceptionEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("exception"),
  data: exceptionDataSchema,
});
export const rejectionEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("unhandled_rejection"),
  data: rejectionDataSchema,
});
export const consoleEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("console_error"),
  data: consoleDataSchema,
});
export const networkEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("network"),
  data: networkDataSchema,
});
export const navigationEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("navigation"),
  data: navigationDataSchema,
});
export const clickEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("click"),
  data: clickDataSchema,
});
export const inputEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("input"),
  data: inputDataSchema,
});
export const messageEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("message"),
  data: messageDataSchema,
});
export const breadcrumbEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("custom_breadcrumb"),
  data: breadcrumbDataSchema,
});
export const sdkEventDetailSchema = eventBaseSchema.extend({
  eventType: z.literal("sdk"),
  data: sdkDataSchema,
});

export const eventDetailSchema = z.discriminatedUnion("eventType", [
  exceptionEventDetailSchema,
  rejectionEventDetailSchema,
  consoleEventDetailSchema,
  networkEventDetailSchema,
  navigationEventDetailSchema,
  clickEventDetailSchema,
  inputEventDetailSchema,
  messageEventDetailSchema,
  breadcrumbEventDetailSchema,
  sdkEventDetailSchema,
]);
export type EventDetail = z.infer<typeof eventDetailSchema>;
