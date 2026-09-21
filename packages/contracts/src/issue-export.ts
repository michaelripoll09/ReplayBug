import { z } from "zod";
import { eventSymbolicationStatusSchema, occurrenceSchema } from "./events.js";
import {
  issueSeveritySchema,
  issueStatusSchema,
  issueTagSummarySchema,
  issueTypeSchema,
} from "./issues.js";
import { sessionEventSchema } from "./sessions.js";
import {
  reproductionErrorCodeSchema,
  reproductionStatusSchema,
} from "./reproductions.js";

/**
 * Single-issue JSON export. Every nested object is an explicit allowlist: the
 * export must never become a serialization of a database row or a dashboard
 * DTO with future fields added to it.
 */

export const issueExportQuerySchema = z
  .object({
    /** Optional retained occurrence to use as the export anchor. */
    eventId: z.string().uuid().optional(),
  })
  .strict();
export type IssueExportQuery = z.infer<typeof issueExportQuerySchema>;

export const issueExportIssueSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    type: issueTypeSchema,
    title: z.string().min(1),
    normalizedMessage: z.string().min(1),
    status: issueStatusSchema,
    severity: issueSeveritySchema,
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    firstRelease: z.string().nullable(),
    lastRelease: z.string().nullable(),
    occurrenceCount: z.number().int().min(0),
    affectedSessionCount: z.number().int().min(0),
    tags: z.array(issueTagSummarySchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strip();
export type IssueExportIssue = z.infer<typeof issueExportIssueSchema>;

export const issueExportRawFrameSchema = z
  .object({
    filename: z.string().optional(),
    function: z.string().optional(),
    lineno: z.number().int().nonnegative().optional(),
    colno: z.number().int().nonnegative().optional(),
    inApp: z.boolean().optional(),
  })
  .strip();
export type IssueExportRawFrame = z.infer<typeof issueExportRawFrameSchema>;

export const issueExportMappedFrameSchema = z
  .object({
    filename: z.string(),
    source: z.string(),
    function: z.string(),
    name: z.string().nullable(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    inApplication: z.boolean(),
    mapped: z.boolean(),
  })
  .strip();
export type IssueExportMappedFrame = z.infer<
  typeof issueExportMappedFrameSchema
>;

const issueExportPreferredFrameSchema = z.union([
  issueExportMappedFrameSchema,
  issueExportRawFrameSchema,
]);

export const issueExportStackSchema = z
  .object({
    symbolicationStatus: eventSymbolicationStatusSchema.nullable(),
    rawFrames: z.array(issueExportRawFrameSchema).max(50),
    mappedFrames: z.array(issueExportMappedFrameSchema).max(50).nullable(),
    preferredStack: z.array(issueExportPreferredFrameSchema).max(50),
  })
  .strip();
export type IssueExportStack = z.infer<typeof issueExportStackSchema>;

export const issueExportReproductionSchema = z
  .object({
    id: z.string().uuid(),
    eventId: z.string().uuid().nullable(),
    status: reproductionStatusSchema,
    language: z.string().min(1),
    framework: z.string().min(1),
    hasRedactedSteps: z.boolean(),
    generatorVersion: z.string().min(1),
    errorCode: reproductionErrorCodeSchema.nullable(),
    completedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strip();
export type IssueExportReproduction = z.infer<
  typeof issueExportReproductionSchema
>;

export const issueExportOccurrenceSchema = occurrenceSchema;
export type IssueExportOccurrence = z.infer<typeof issueExportOccurrenceSchema>;

export const issueExportTimelineEventSchema = sessionEventSchema;
export type IssueExportTimelineEvent = z.infer<
  typeof issueExportTimelineEventSchema
>;

export const issueExportSchema = z
  .object({
    exportedAt: z.string().datetime(),
    issue: issueExportIssueSchema,
    occurrence: issueExportOccurrenceSchema.nullable(),
    stack: issueExportStackSchema.nullable(),
    timeline: z.array(issueExportTimelineEventSchema).max(26),
    reproductions: z.array(issueExportReproductionSchema).max(20),
  })
  .strip();
export type IssueExport = z.infer<typeof issueExportSchema>;

/** Alias used by callers that name the root contract after the HTTP response. */
export const issueExportResponseSchema = issueExportSchema;
export type IssueExportResponse = IssueExport;
