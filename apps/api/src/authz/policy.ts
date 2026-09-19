import type { WorkspaceRole } from "@replaybug/contracts";

/**
 * Central capability policy. No scattered `if (role === ...)` checks:
 * every authorization decision goes through `hasCapability` or one of the
 * typed helpers below.
 *
 * Matrix (workspace-scoped):
 * - owner: everything (manage workspace, projects, envs, origins, keys)
 * - admin: manage projects, envs, origins, keys; cannot transfer ownership
 *   (ownership transfer is out of scope this block, so owner==admin except
 *   workspace deletion which is not exposed this block)
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
  | "reproduction:generate";

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

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
  },
};
