import { z } from "zod";

/** Workspace roles. Exact set; no other value is valid anywhere. */
export const workspaceRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "viewer",
]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** Roles that may be granted by an invitation; ownership is never invited. */
export const workspaceInvitationRoleSchema = z.enum([
  "admin",
  "member",
  "viewer",
]);

export type WorkspaceInvitationRole = z.infer<
  typeof workspaceInvitationRoleSchema
>;

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

/** Destructive workspace deletion requires the current slug verbatim. */
export const deleteWorkspaceRequestSchema = z
  .object({
    confirmation: z.string().min(1).max(100),
  })
  .strict();

export type DeleteWorkspaceRequest = z.infer<
  typeof deleteWorkspaceRequestSchema
>;

export const workspaceDeletionRequestSchema = deleteWorkspaceRequestSchema;
export type WorkspaceDeletionRequest = DeleteWorkspaceRequest;

export const deleteWorkspaceResponseSchema = z
  .object({ deleted: z.boolean() })
  .strict();

export type DeleteWorkspaceResponse = z.infer<
  typeof deleteWorkspaceResponseSchema
>;

export const workspaceDeletionResponseSchema = deleteWorkspaceResponseSchema;
export type WorkspaceDeletionResponse = DeleteWorkspaceResponse;

/** Invitation lifecycle state derived from immutable timestamps and status fields. */
export const workspaceInvitationStatusSchema = z.enum([
  "pending",
  "expired",
  "accepted",
  "revoked",
]);

export type WorkspaceInvitationStatus = z.infer<
  typeof workspaceInvitationStatusSchema
>;

const invitationEmailInputSchema = z
  .string()
  .min(3)
  .max(320)
  .refine(
    (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()),
    "Invitation email has an invalid format",
  );

const invitationTokenSchema = z
  .string()
  .regex(/^rb_inv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/u);

/** Safe invitation metadata. Token hashes and plaintext are never DTO fields. */
export const workspaceInvitationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    email: z.string().email(),
    role: workspaceInvitationRoleSchema,
    tokenPrefix: z.string().regex(/^[0-9a-f]{8}$/u),
    status: workspaceInvitationStatusSchema,
    expiresAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdByUserId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceInvitation = z.infer<typeof workspaceInvitationSchema>;

/** Create accepts raw input; the service performs the single normalization step. */
export const createWorkspaceInvitationRequestSchema = z
  .object({
    email: invitationEmailInputSchema,
    role: workspaceInvitationRoleSchema,
  })
  .strict();

export type CreateWorkspaceInvitationRequest = z.infer<
  typeof createWorkspaceInvitationRequestSchema
>;

/** Plaintext is intentionally present only in this one-time creation response. */
export const createWorkspaceInvitationResponseSchema = workspaceInvitationSchema
  .extend({
    token: invitationTokenSchema,
    inviteUrl: z.string().url(),
    deliveryNote: z.string().min(1),
  })
  .strict();

export type CreateWorkspaceInvitationResponse = z.infer<
  typeof createWorkspaceInvitationResponseSchema
>;

export const workspaceInvitationListResponseSchema = z.array(
  workspaceInvitationSchema,
);

export type WorkspaceInvitationListResponse = z.infer<
  typeof workspaceInvitationListResponseSchema
>;

export const workspaceInvitationRevokeResponseSchema =
  workspaceInvitationSchema;

export type WorkspaceInvitationRevokeResponse = z.infer<
  typeof workspaceInvitationRevokeResponseSchema
>;

export const workspaceInvitationAcceptResponseSchema = z
  .object({
    invitationId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    membershipId: z.string().uuid(),
    role: workspaceInvitationRoleSchema,
    acceptedAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceInvitationAcceptResponse = z.infer<
  typeof workspaceInvitationAcceptResponseSchema
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
