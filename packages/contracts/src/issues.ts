import { z } from "zod";
import { userSummarySchema } from "./user.js";

/**
 * Block 6 issue workflow DTOs.
 *
 * These shapes are the API's public promise: they are built from Drizzle
 * rows by service mappers, never by spreading a row. Fingerprint material
 * (`fingerprint`, `fingerprint_signature`) is grouping internals and never
 * appears here; `.strip()` (default) drops it if a mapper leaks it.
 */

export const issueStatusSchema = z.enum([
  "open",
  "investigating",
  "resolved",
  "ignored",
]);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

export const issueTypeSchema = z.enum([
  "exception",
  "unhandled_rejection",
  "console_error",
  "network",
  "message",
]);
export type IssueType = z.infer<typeof issueTypeSchema>;

export const issueSeveritySchema = z.enum(["error", "warning"]);
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;

export const issueSortSchema = z.enum([
  "last_seen",
  "first_seen",
  "occurrence_count",
  "affected_sessions",
]);
export type IssueSort = z.infer<typeof issueSortSchema>;

export const sortOrderSchema = z.enum(["asc", "desc"]);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** Tag summary embedded in issue payloads. */
export const issueTagSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
});
export type IssueTagSummary = z.infer<typeof issueTagSummarySchema>;

/**
 * Issue list/detail DTO. No `payload_json`, no fingerprint material, no
 * pg-boss or key-hash fields.
 */
export const issueSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  type: issueTypeSchema,
  title: z.string().min(1),
  normalizedMessage: z.string().min(1),
  status: issueStatusSchema,
  severity: issueSeveritySchema,
  assignee: userSummarySchema.nullable(),
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
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** Issue list filters/sort with bounded keyset pagination. */
export const issueListQuerySchema = z.object({
  status: issueStatusSchema.optional(),
  environment: z.string().trim().min(1).max(100).optional(),
  release: z.string().trim().min(1).max(200).optional(),
  type: issueTypeSchema.optional(),
  assigneeId: z.string().min(1).optional(),
  /** When true, only issues with no assignee. */
  unassigned: z.coerce.boolean().optional(),
  /** Tag slug (project-local). */
  tag: z.string().trim().min(1).max(100).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  /** Free-text search over title/normalized message (+tags). */
  q: z.string().trim().min(1).max(200).optional(),
  sort: issueSortSchema.default("last_seen"),
  order: sortOrderSchema.default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque keyset cursor from a previous `nextCursor`. */
  cursor: z.string().min(1).optional(),
});
export type IssueListQuery = z.infer<typeof issueListQuerySchema>;

/** Status transition request. `resolved_at` rules live server-side. */
export const updateIssueStatusRequestSchema = z.object({
  status: issueStatusSchema,
});
export type UpdateIssueStatusRequest = z.infer<
  typeof updateIssueStatusRequestSchema
>;

/** Assignment request. Explicit `null` unassigns. User ids are opaque
 * Better Auth strings, not necessarily UUIDs (`user.id` is text). */
export const updateIssueAssigneeRequestSchema = z.object({
  userId: z.string().min(1).max(200).nullable(),
});
export type UpdateIssueAssigneeRequest = z.infer<
  typeof updateIssueAssigneeRequestSchema
>;

export const issueActivityTypeSchema = z.enum([
  "created",
  "assigned",
  "unassigned",
  "status_changed",
  "comment_added",
  "regression_detected",
  "reproduction_generated",
  "ai_analysis_requested",
  "ai_analysis_completed",
  "ai_analysis_failed",
]);
export type IssueActivityType = z.infer<typeof issueActivityTypeSchema>;

/**
 * Activity DTO. Metadata carries safe transition hints only
 * (`{from,to}`, `{userId}`); comment bodies and payloads never appear here.
 */
export const issueActivitySchema = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  type: issueActivityTypeSchema,
  actor: userSummarySchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type IssueActivity = z.infer<typeof issueActivitySchema>;

/**
 * Comment DTO. The body is Markdown source; clients must render it through
 * a sanitizer, never as raw HTML.
 */
export const issueCommentSchema = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  author: userSummarySchema,
  bodyMarkdown: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IssueComment = z.infer<typeof issueCommentSchema>;

export const createCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

export const updateCommentRequestSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;

/** Bounded newest-first activity listing. */
export const activityListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

/** Bounded oldest-first comment listing. */
export const commentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;

/** Project-local tag DTO. */
export const issueTagSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type IssueTag = z.infer<typeof issueTagSchema>;

export const createTagRequestSchema = z.object({
  /** Display name; the server derives the deterministic slug. */
  name: z.string().trim().min(1).max(50),
});
export type CreateTagRequest = z.infer<typeof createTagRequestSchema>;
