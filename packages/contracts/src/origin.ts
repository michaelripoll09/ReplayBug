import { z } from "zod";

export const projectOriginSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  origin: z.string().min(1),
  isEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectOrigin = z.infer<typeof projectOriginSchema>;

export const createOriginRequestSchema = z.object({
  origin: z.string().trim().min(1).max(2000),
  isEnabled: z.boolean().optional(),
});

export type CreateOriginRequest = z.infer<typeof createOriginRequestSchema>;

export const updateOriginRequestSchema = z
  .object({
    origin: z.string().trim().min(1).max(2000).optional(),
    isEnabled: z.boolean().optional(),
  })
  .refine((v) => v.origin !== undefined || v.isEnabled !== undefined, {
    message: "At least one field is required",
  });

export type UpdateOriginRequest = z.infer<typeof updateOriginRequestSchema>;
