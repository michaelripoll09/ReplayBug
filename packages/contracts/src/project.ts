import { z } from "zod";

/** Project DTO. Never includes key material. */
export const projectSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  timezone: z.string().min(1),
  retentionDays: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/i,
      "Slug must be lowercase alphanumeric with single hyphens",
    )
    .optional(),
  description: z.string().trim().max(2000).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  retentionDays: z.number().int().min(7).max(365).optional(),
});

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/i,
        "Slug must be lowercase alphanumeric with single hyphens",
      )
      .optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    retentionDays: z.number().int().min(7).max(365).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.slug !== undefined ||
      v.description !== undefined ||
      v.timezone !== undefined ||
      v.retentionDays !== undefined,
    { message: "At least one field is required" },
  );

export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/** Project bootstrap returned once on creation: one-time plaintext key. */
export const projectBootstrapSchema = z.object({
  key: z.string().min(1),
  prefix: z.string().min(1),
  projectId: z.string().uuid(),
  /** Explicitly future ingest endpoint; non-functional in this block. */
  ingestEndpoint: z.string().min(1),
  ingestEnabled: z.literal(false),
  note: z.string().min(1),
});

export type ProjectBootstrap = z.infer<typeof projectBootstrapSchema>;

export const projectWithBootstrapSchema = z.object({
  project: projectSchema,
  bootstrap: projectBootstrapSchema,
});

export type ProjectWithBootstrap = z.infer<typeof projectWithBootstrapSchema>;

export function normalizeProjectSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
