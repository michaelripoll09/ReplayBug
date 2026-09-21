import type { WorkspaceRole } from "@replaybug/contracts";

/**
 * Central capability policy. No scattered `if (role === ...)` checks:
 * every authorization decision goes through `hasCapability` or one of the
 * typed helpers below.
 *
 * Matrix (workspace-scoped):
 * - owner: everything, including governance, retention, transfer, and deletion
 * - admin: manage projects, governance, and project settings; cannot transfer
 *   ownership or delete the workspace
 * - member: read + inspect telemetry (read projects/envs/origins/keys meta);
 *   cannot create/update/delete projects, envs, origins or rotate keys.
 *   Secret tokens (`project:manage-secret-tokens`) are owner/admin only:
 *   member and viewer cannot list, create or revoke them.
 *   Block 6: member additionally manages issues (status, assignment, tags,
 *   comments) and reads sessions + own notifications.
 * - viewer: read-only (same read set as member this block). Block 6: issue,
 *   session and own-notification reads only; no issue mutation.
 *   Playwright reproductions: `reproduction:read` min viewer,
 *   `reproduction:generate` min member.
 *
 * Project access is derived from workspace membership: there is no
 * project-membership system. Any workspace member can read any project in
 * that workspace; only owner/admin can write.
 */

export type Capability =
  | "workspace:read"
  | "workspace:update"
  | "project:create"
  | "project:read"
  | "project:update"
  | "project:delete"
  | "environment:read"
  | "environment:write"
  | "origin:read"
  | "origin:write"
  | "key:read"
  | "key:rotate"
  | "project:manage-secret-tokens"
  | "issue:read"
  | "issue:update-status"
  | "issue:assign"
  | "issue:manage-tags"
  | "issue:comment"
  | "session:read"
  | "notification:read-own"
  | "reproduction:read"
  | "reproduction:generate"
  | "ai-analysis:read"
  | "ai-analysis:request"
  | "workspace:manage-invitations"
  | "workspace:manage-members"
  | "workspace:read-audit"
  | "workspace:transfer-ownership"
  | "workspace:delete"
  | "project:update-retention";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export type WorkspaceMemberRole = Exclude<WorkspaceRole, "owner">;

/** Numeric hierarchy used by all workspace governance decisions. */
export function workspaceRoleRank(role: WorkspaceRole): number {
  return ROLE_RANK[role];
}

export function compareWorkspaceRoles(
  left: WorkspaceRole,
  right: WorkspaceRole,
): number {
  return workspaceRoleRank(left) - workspaceRoleRank(right);
}

export function isWorkspaceRoleAtLeast(
  role: WorkspaceRole,
  minimum: WorkspaceRole,
): boolean {
  return compareWorkspaceRoles(role, minimum) >= 0;
}

/**
 * Owner may mutate every non-owner role. Admin may mutate member/viewer only.
 * Ownership changes have a dedicated owner-only transaction and never use
 * this generic role route.
 */
export function canChangeMemberRole(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole: WorkspaceMemberRole,
): boolean {
  if (targetRole === "owner") {
    return false;
  }
  if (actorRole === "owner") {
    return true;
  }
  return (
    actorRole === "admin" &&
    (targetRole === "member" || targetRole === "viewer") &&
    (nextRole === "member" || nextRole === "viewer")
  );
}

/** Owner may remove any non-owner; admin may remove member/viewer only. */
export function canRemoveMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
): boolean {
  if (targetRole === "owner") {
    return false;
  }
  if (actorRole === "owner") {
    return true;
  }
  return (
    actorRole === "admin" &&
    (targetRole === "member" || targetRole === "viewer")
  );
}

/** Any current workspace member may use the explicit leave route. */
export function canLeaveWorkspace(role: WorkspaceRole): boolean {
  return isWorkspaceRoleAtLeast(role, "viewer");
}

const CAPABILITY_MIN_ROLE: Record<Capability, WorkspaceRole> = {
  "workspace:read": "viewer",
  "workspace:update": "owner",
  "project:create": "admin",
  "project:read": "viewer",
  "project:update": "admin",
  "project:delete": "admin",
  "environment:read": "viewer",
  "environment:write": "admin",
  "origin:read": "viewer",
  "origin:write": "admin",
  "key:read": "viewer",
  "key:rotate": "admin",
  "project:manage-secret-tokens": "admin",
  "issue:read": "viewer",
  "issue:update-status": "member",
  "issue:assign": "member",
  "issue:manage-tags": "member",
  "issue:comment": "member",
  "session:read": "viewer",
  "notification:read-own": "viewer",
  "reproduction:read": "viewer",
  "reproduction:generate": "member",
  "ai-analysis:read": "viewer",
  "ai-analysis:request": "member",
  "workspace:manage-invitations": "admin",
  "workspace:manage-members": "admin",
  "workspace:read-audit": "admin",
  "workspace:transfer-ownership": "owner",
  "workspace:delete": "owner",
  "project:update-retention": "admin",
};

export function hasCapability(
  role: WorkspaceRole,
  capability: Capability,
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}

export function canRead(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:read");
}

export function canManageProjects(role: WorkspaceRole): boolean {
  return hasCapability(role, "project:create");
}

export function canManageEnvironments(role: WorkspaceRole): boolean {
  return hasCapability(role, "environment:write");
}

export function canManageOrigins(role: WorkspaceRole): boolean {
  return hasCapability(role, "origin:write");
}

export function canRotateKeys(role: WorkspaceRole): boolean {
  return hasCapability(role, "key:rotate");
}

export function canManageSecretTokens(role: WorkspaceRole): boolean {
  return hasCapability(role, "project:manage-secret-tokens");
}

export function canReadIssues(role: WorkspaceRole): boolean {
  return hasCapability(role, "issue:read");
}

export function canUpdateIssueStatus(role: WorkspaceRole): boolean {
  return hasCapability(role, "issue:update-status");
}

export function canAssignIssues(role: WorkspaceRole): boolean {
  return hasCapability(role, "issue:assign");
}

export function canManageIssueTags(role: WorkspaceRole): boolean {
  return hasCapability(role, "issue:manage-tags");
}

export function canCommentOnIssues(role: WorkspaceRole): boolean {
  return hasCapability(role, "issue:comment");
}

export function canReadSessions(role: WorkspaceRole): boolean {
  return hasCapability(role, "session:read");
}

export function canReadOwnNotifications(role: WorkspaceRole): boolean {
  return hasCapability(role, "notification:read-own");
}

export function canReadReproductions(role: WorkspaceRole): boolean {
  return hasCapability(role, "reproduction:read");
}

export function canGenerateReproductions(role: WorkspaceRole): boolean {
  return hasCapability(role, "reproduction:generate");
}

export function canReadAiAnalysis(role: WorkspaceRole): boolean {
  return hasCapability(role, "ai-analysis:read");
}

export function canRequestAiAnalysis(role: WorkspaceRole): boolean {
  return hasCapability(role, "ai-analysis:request");
}

export function canManageInvitations(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:manage-invitations");
}

/** Invitation creation uses the same centralized governance capability. */
export function canInviteMembers(role: WorkspaceRole): boolean {
  return canManageInvitations(role);
}

export function canManageMembers(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:manage-members");
}

export function canReadAudit(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:read-audit");
}

export function canTransferOwnership(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:transfer-ownership");
}

export function canDeleteWorkspace(role: WorkspaceRole): boolean {
  return hasCapability(role, "workspace:delete");
}

export function canUpdateRetention(role: WorkspaceRole): boolean {
  return hasCapability(role, "project:update-retention");
}

/** RBAC matrix for docs/tests. */
export const RBAC_MATRIX: Record<WorkspaceRole, Record<Capability, boolean>> = {
  owner: {
    "workspace:read": true,
    "workspace:update": true,
    "project:create": true,
    "project:read": true,
    "project:update": true,
    "project:delete": true,
    "environment:read": true,
    "environment:write": true,
    "origin:read": true,
    "origin:write": true,
    "key:read": true,
    "key:rotate": true,
    "project:manage-secret-tokens": true,
    "issue:read": true,
    "issue:update-status": true,
    "issue:assign": true,
    "issue:manage-tags": true,
    "issue:comment": true,
    "session:read": true,
    "notification:read-own": true,
    "reproduction:read": true,
    "reproduction:generate": true,
    "ai-analysis:read": true,
    "ai-analysis:request": true,
    "workspace:manage-invitations": true,
    "workspace:manage-members": true,
    "workspace:read-audit": true,
    "workspace:transfer-ownership": true,
    "workspace:delete": true,
    "project:update-retention": true,
  },
  admin: {
    "workspace:read": true,
    "workspace:update": false,
    "project:create": true,
    "project:read": true,
    "project:update": true,
    "project:delete": true,
    "environment:read": true,
    "environment:write": true,
    "origin:read": true,
    "origin:write": true,
    "key:read": true,
    "key:rotate": true,
    "project:manage-secret-tokens": true,
    "issue:read": true,
    "issue:update-status": true,
    "issue:assign": true,
    "issue:manage-tags": true,
    "issue:comment": true,
    "session:read": true,
    "notification:read-own": true,
    "reproduction:read": true,
    "reproduction:generate": true,
    "ai-analysis:read": true,
    "ai-analysis:request": true,
    "workspace:manage-invitations": true,
    "workspace:manage-members": true,
    "workspace:read-audit": true,
    "workspace:transfer-ownership": false,
    "workspace:delete": false,
    "project:update-retention": true,
  },
  member: {
    "workspace:read": true,
    "workspace:update": false,
    "project:create": false,
    "project:read": true,
    "project:update": false,
    "project:delete": false,
    "environment:read": true,
    "environment:write": false,
    "origin:read": true,
    "origin:write": false,
    "key:read": true,
    "key:rotate": false,
    "project:manage-secret-tokens": false,
    "issue:read": true,
    "issue:update-status": true,
    "issue:assign": true,
    "issue:manage-tags": true,
    "issue:comment": true,
    "session:read": true,
    "notification:read-own": true,
    "reproduction:read": true,
    "reproduction:generate": true,
    "ai-analysis:read": true,
    "ai-analysis:request": true,
    "workspace:manage-invitations": false,
    "workspace:manage-members": false,
    "workspace:read-audit": false,
    "workspace:transfer-ownership": false,
    "workspace:delete": false,
    "project:update-retention": false,
  },
  viewer: {
    "workspace:read": true,
    "workspace:update": false,
    "project:create": false,
    "project:read": true,
    "project:update": false,
    "project:delete": false,
    "environment:read": true,
    "environment:write": false,
    "origin:read": true,
    "origin:write": false,
    "key:read": true,
    "key:rotate": false,
    "project:manage-secret-tokens": false,
    "issue:read": true,
    "issue:update-status": false,
    "issue:assign": false,
    "issue:manage-tags": false,
    "issue:comment": false,
    "session:read": true,
    "notification:read-own": true,
    "reproduction:read": true,
    "reproduction:generate": false,
    "ai-analysis:read": true,
    "ai-analysis:request": false,
    "workspace:manage-invitations": false,
    "workspace:manage-members": false,
    "workspace:read-audit": false,
    "workspace:transfer-ownership": false,
    "workspace:delete": false,
    "project:update-retention": false,
  },
};
