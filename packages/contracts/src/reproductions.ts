import { z } from "zod";
import { pagedResponseSchema } from "./pagination.js";

/**
 * Playwright reproduction DTOs.
 *
 * These shapes are the API's public promise: they are built from Drizzle
 * rows by service mappers, never by spreading a row. The stored Playwright
 * `code` only appears on the detail DTO; list payloads stay small.
 * `generatedBy` carries the requesting user's identity snapshot
 * (`user.id` is opaque text, not a UUID).
 */

export const reproductionStatusSchema = z.enum(["pending", "ready", "failed"]);
export type ReproductionStatus = z.infer<typeof reproductionStatusSchema>;

export const reproductionErrorCodeSchema = z.enum([
  "REPRODUCTION_BASE_URL_REQUIRED",
  "REPRODUCTION_UNSUPPORTED_FAILURE",
  "REPRODUCTION_OUTPUT_TOO_LARGE",
  "REPRODUCTION_INVALID_EVIDENCE",
  "REPRODUCTION_FAILED",
]);
export type ReproductionErrorCode = z.infer<typeof reproductionErrorCodeSchema>;

/** Identity snapshot of the user that requested the reproduction. */
export const reproductionGeneratedBySchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
});
export type ReproductionGeneratedBy = z.infer<
  typeof reproductionGeneratedBySchema
>;

/**
 * Reproduction list DTO. No Playwright `code`, no error details, no
 * idempotency material.
 */
export const reproductionSummarySchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  status: reproductionStatusSchema,
  hasRedactedSteps: z.boolean(),
  generatorVersion: z.string().min(1),
  generatedBy: reproductionGeneratedBySchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type ReproductionSummary = z.infer<typeof reproductionSummarySchema>;

/**
 * Reproduction detail DTO. Extends the summary with the owning issue,
 * the generator flavor, the Playwright source (null until ready) and
 * failure diagnostics (null unless failed).
 */
export const reproductionDetailSchema = reproductionSummarySchema.extend({
  issueId: z.string().uuid(),
  language: z.string().min(1),
  framework: z.string().min(1),
  code: z.string().nullable(),
  errorCode: reproductionErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
});
export type ReproductionDetail = z.infer<typeof reproductionDetailSchema>;

/**
 * Acknowledgement returned when a reproduction generation is accepted.
 * The worker completes the record asynchronously via the outbox.
 */
export const createReproductionResponseSchema = z.object({
  id: z.string().uuid(),
  issueId: z.string().uuid(),
  eventId: z.string().uuid(),
  status: reproductionStatusSchema,
});
export type CreateReproductionResponse = z.infer<
  typeof createReproductionResponseSchema
>;

/** Bounded newest-first reproduction listing. */
export const reproductionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque keyset cursor from a previous `nextCursor`. */
  cursor: z.string().min(1).optional(),
});
export type ReproductionListQuery = z.infer<typeof reproductionListQuerySchema>;

export const reproductionListResponseSchema = pagedResponseSchema(
  reproductionSummarySchema,
);
export type ReproductionListResponse = z.infer<
  typeof reproductionListResponseSchema
>;
