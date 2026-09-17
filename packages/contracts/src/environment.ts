import { z } from "zod";

export const environmentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  baseUrl: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectEnvironment = z.infer<typeof environmentSchema>;

export const createEnvironmentRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().max(2000).optional(),
  isDefault: z.boolean().optional(),
});

export type CreateEnvironmentRequest = z.infer<
  typeof createEnvironmentRequestSchema
>;

export const updateEnvironmentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.string().trim().max(2000).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.baseUrl !== undefined ||
      v.isDefault !== undefined,
    {
      message: "At least one field is required",
    },
  );

export type UpdateEnvironmentRequest = z.infer<
  typeof updateEnvironmentRequestSchema
>;
