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
 *   cannot create/update/delete projects, envs, origins or rotate keys
 * - viewer: read-only (same read set as member this block)
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
  | "key:rotate";

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
  },
};
