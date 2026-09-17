import { z } from "zod";

/**
 * Base error envelope for all ReplayBug business API errors.
 * Contains a machine-readable code, a human-readable message, the request
 * ID for support/debugging, and optional field-level validation details.
 */
export const errorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
  details: z.unknown().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
