import { z } from "zod";
import { userSummarySchema } from "./user.js";
import { workspaceMemberSchema, workspaceRoleSchema } from "./workspace.js";

/** Roles that can be assigned without transferring ownership. */
export const workspaceMemberRoleSchema = z.enum(["admin", "member", "viewer"]);
export type WorkspaceMemberRole = z.infer<typeof workspaceMemberRoleSchema>;

/** Strict role mutation input; ownership transfers use a separate endpoint. */
export const updateWorkspaceMemberRoleRequestSchema = z
  .object({
    role: workspaceMemberRoleSchema,
  })
  .strict();
export type UpdateWorkspaceMemberRoleRequest = z.infer<
  typeof updateWorkspaceMemberRoleRequestSchema
>;

export const workspaceMemberRoleMutationRequestSchema =
  updateWorkspaceMemberRoleRequestSchema;
export type WorkspaceMemberRoleMutationRequest =
  UpdateWorkspaceMemberRoleRequest;

/** The role route returns the same safe member shape as the member list. */
export const updateWorkspaceMemberRoleResponseSchema =
  workspaceMemberSchema.strict();
export type UpdateWorkspaceMemberRoleResponse = z.infer<
  typeof updateWorkspaceMemberRoleResponseSchema
>;

export const workspaceMemberRoleMutationResponseSchema =
  updateWorkspaceMemberRoleResponseSchema;
export type WorkspaceMemberRoleMutationResponse =
  UpdateWorkspaceMemberRoleResponse;

/** Removal and leave responses intentionally contain no internal row data. */
export const removeWorkspaceMemberResponseSchema = z
  .object({
    removed: z.literal(true),
  })
  .strict();
export type RemoveWorkspaceMemberResponse = z.infer<
  typeof removeWorkspaceMemberResponseSchema
>;

export const leaveWorkspaceResponseSchema = z
  .object({
    left: z.literal(true),
  })
  .strict();
export type LeaveWorkspaceResponse = z.infer<
  typeof leaveWorkspaceResponseSchema
>;

export const transferWorkspaceOwnershipRequestSchema = z
  .object({
    userId: z.string().min(1).max(200),
  })
  .strict();
export type TransferWorkspaceOwnershipRequest = z.infer<
  typeof transferWorkspaceOwnershipRequestSchema
>;

export const workspaceOwnershipTransferRequestSchema =
  transferWorkspaceOwnershipRequestSchema;
export type WorkspaceOwnershipTransferRequest =
  TransferWorkspaceOwnershipRequest;

/** IDs are opaque Better Auth user ids; the workspace id remains a UUID. */
export const transferWorkspaceOwnershipResponseSchema = z
  .object({
    workspaceId: z.string().uuid(),
    previousOwnerId: z.string().min(1),
    newOwnerId: z.string().min(1),
  })
  .strict();
export type TransferWorkspaceOwnershipResponse = z.infer<
  typeof transferWorkspaceOwnershipResponseSchema
>;

export const workspaceOwnershipTransferResponseSchema =
  transferWorkspaceOwnershipResponseSchema;
export type WorkspaceOwnershipTransferResponse =
  TransferWorkspaceOwnershipResponse;

/** All actions currently accepted by the audit_logs database constraint. */
export const WORKSPACE_AUDIT_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.ownership_transferred",
  "workspace.deletion_requested",
  "workspace.deletion_completed",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.retention_changed",
  "project.deletion_requested",
  "project.deletion_completed",
  "workspace_invitation.created",
  "workspace_invitation.revoked",
  "workspace_invitation.accepted",
  "workspace_member.role_changed",
  "workspace_member.removed",
  "project_origin.created",
  "project_origin.updated",
  "project_origin.deleted",
  "project_key.rotated",
] as const;

export const workspaceAuditActionSchema = z.enum(WORKSPACE_AUDIT_ACTIONS);
export type WorkspaceAuditAction = z.infer<typeof workspaceAuditActionSchema>;

/** Safe actor identity plus sanitized, bounded metadata. */
export const workspaceAuditEventSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid().nullable(),
    action: workspaceAuditActionSchema,
    actor: userSummarySchema.strict().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type WorkspaceAuditEvent = z.infer<typeof workspaceAuditEventSchema>;

/** Newest-first keyset pagination over (created_at, id). */
export const workspaceAuditCursorSchema = z.string().min(1).max(256);
export type WorkspaceAuditCursor = z.infer<typeof workspaceAuditCursorSchema>;

export const workspaceAuditFilterSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: workspaceAuditCursorSchema.optional(),
    action: workspaceAuditActionSchema.optional(),
  })
  .strict();
export type WorkspaceAuditFilter = z.infer<typeof workspaceAuditFilterSchema>;

export const workspaceAuditQuerySchema = workspaceAuditFilterSchema;
export type WorkspaceAuditQuery = WorkspaceAuditFilter;

export const workspaceAuditPageSchema = z
  .object({
    items: z.array(workspaceAuditEventSchema),
    nextCursor: workspaceAuditCursorSchema.optional(),
  })
  .strict();
export type WorkspaceAuditPage = z.infer<typeof workspaceAuditPageSchema>;

export const workspaceAuditResponseSchema = workspaceAuditPageSchema;
export type WorkspaceAuditResponse = WorkspaceAuditPage;

/** Keeps the role import part of the governance contract surface explicit. */
export const workspaceGovernanceRoleSchema = workspaceRoleSchema;
export type WorkspaceGovernanceRole = z.infer<
  typeof workspaceGovernanceRoleSchema
>;
