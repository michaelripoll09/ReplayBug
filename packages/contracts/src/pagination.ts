import { z } from "zod";

/** Machine-readable error codes for the Block 2 envelope extension. */
export const apiErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "INTERNAL_ERROR",
  "REQUEST_ERROR",
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** Bounded list query for small configuration collections. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const pagedResponseSchema = <T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<{ items: z.infer<T>[]; nextCursor?: string }> =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  }) as z.ZodType<{ items: z.infer<T>[]; nextCursor?: string }>;
