import { z } from "zod";

export const AI_ANALYSIS_VERSION = "1.0.0";

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string().datetime();
const boundedText = (minimum: number, maximum: number) =>
  z.string().min(minimum).max(maximum);

export const aiAnalysisStatusSchema = z.enum(["pending", "ready", "failed"]);
export type AiAnalysisStatus = z.infer<typeof aiAnalysisStatusSchema>;

/** Opaque, deterministic evidence reference emitted by the evidence builder. */
export const aiAnalysisEvidenceReferenceSchema = z
  .object({
    ref: boundedText(1, 128),
  })
  .strict();
export type AiAnalysisEvidenceReference = z.infer<
  typeof aiAnalysisEvidenceReferenceSchema
>;

export const aiAnalysisEvidenceSchema = aiAnalysisEvidenceReferenceSchema
  .extend({
    reason: boundedText(1, 2_000),
  })
  .strict();
export type AiAnalysisEvidence = z.infer<typeof aiAnalysisEvidenceSchema>;

/** The only provider result shape that may be persisted or returned. */
export const aiAnalysisOutputSchema = z
  .object({
    summary: boundedText(1, 4_000),
    suspectedCause: boundedText(1, 4_000),
    evidence: z.array(aiAnalysisEvidenceSchema).min(1).max(20),
    reproductionSteps: z.array(boundedText(1, 1_000)).min(1).max(10),
    limitations: z.array(boundedText(1, 1_000)).max(10),
  })
  .strict();
export type AiAnalysisOutput = z.infer<typeof aiAnalysisOutputSchema>;

const aiAnalysisBaseSchema = z
  .object({
    id: uuidSchema,
    issueId: uuidSchema,
    eventId: uuidSchema.nullable(),
    model: boundedText(1, 256),
    status: aiAnalysisStatusSchema,
    requestedByUserId: boundedText(1, 256).nullable(),
    analysisVersion: boundedText(1, 32),
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

/** Small, newest-first history entry. It intentionally omits result text. */
export const aiAnalysisSummarySchema = aiAnalysisBaseSchema;
export type AiAnalysisSummary = z.infer<typeof aiAnalysisSummarySchema>;

export const aiAnalysisDetailSchema = aiAnalysisBaseSchema
  .extend({
    result: aiAnalysisOutputSchema.nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .nullable(),
    errorMessage: boundedText(1, 1_000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "pending") {
      if (
        value.completedAt !== null ||
        value.result !== null ||
        value.errorCode !== null ||
        value.errorMessage !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pending analyses cannot contain terminal data",
        });
      }
      return;
    }
    if (value.completedAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Terminal analyses must be completed",
      });
    }
    if (value.status === "ready") {
      if (
        value.result === null ||
        value.errorCode !== null ||
        value.errorMessage !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ready analyses require only a result",
        });
      }
      return;
    }
    if (
      value.result !== null ||
      value.errorCode === null ||
      value.errorMessage === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Failed analyses require only error diagnostics",
      });
    }
  });
export type AiAnalysisDetail = z.infer<typeof aiAnalysisDetailSchema>;

export const aiAnalysisListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: boundedText(1, 512).optional(),
  })
  .strict();
export type AiAnalysisListQuery = z.infer<typeof aiAnalysisListQuerySchema>;

export const aiAnalysisListResponseSchema = z
  .object({
    items: z.array(aiAnalysisSummarySchema).max(100),
    nextCursor: boundedText(1, 512).nullable(),
  })
  .strict();
export type AiAnalysisListResponse = z.infer<
  typeof aiAnalysisListResponseSchema
>;

/** pg-boss payload: identifiers only, never evidence, prompts, or output. */
export const aiAnalysisJobPayloadSchema = z
  .object({
    version: z.literal(1),
    analysisId: uuidSchema,
  })
  .strict();
export type AiAnalysisJobPayload = z.infer<typeof aiAnalysisJobPayloadSchema>;
