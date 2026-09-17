/**
 * RBAC UX layer derived from backend types only.
 *
 * No second permission matrix lives in Next.js: these helpers map the
 * backend `WorkspaceRole` ("owner"|"admin"|"member"|"viewer") to UI affordances
 * (show, hide-or-readonly). The backend remains the enforcement authority;
 * the UI never grants what the API forbids, it only hides controls that
 * would deterministically 403.
 *
 * Backend-tested enforcement proof: apps/api/src/routes/tenancy.integration.test.ts
 * ("enforces RBAC: member read-only...") proves member 403 on create/rotate
 * and cross-tenant 404.
 */

/** Mirrors `@replaybug/contracts` workspaceRoleSchema. Backend is authority. */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === "owner";
}

export function canCreateProject(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function canManageProject(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function canManageEnvironments(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function canManageOrigins(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function canRotateKeys(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function isReadOnly(role: WorkspaceRole): boolean {
  return role === "member" || role === "viewer";
}

export function roleLabel(role: WorkspaceRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    case "viewer":
      return "Viewer";
  }
}
