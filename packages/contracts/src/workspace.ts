import { z } from "zod";

/** Workspace roles. Exact set; no other value is valid anywhere. */
export const workspaceRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "viewer",
]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Workspace DTO. DB model != DTO: no internal columns leak. */
export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

/** Workspace with the requesting user's role (used by list-mine). */
export const workspaceWithRoleSchema = workspaceSchema.extend({
  role: workspaceRoleSchema,
});

export type WorkspaceWithRole = z.infer<typeof workspaceWithRoleSchema>;

/**
 * Workspace membership DTO: read-only minimum for assignment pickers.
 * No management operations (invite/remove/role) exist in Block 6.
 */
export const workspaceMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  role: workspaceRoleSchema,
});

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const createWorkspaceRequestSchema = z.object({
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
});

export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;

export const updateWorkspaceRequestSchema = z
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
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: "At least one of name or slug is required",
  });

export type UpdateWorkspaceRequest = z.infer<
  typeof updateWorkspaceRequestSchema
>;

/** Normalize a workspace slug: trim, lowercase, spaces/underscores to hyphens. */
export function normalizeWorkspaceSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
