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

/**
 * RS-10 secret project tokens (CLI/CI-only). Mirrors the backend
 * `project:manage-secret-tokens` capability (owner/admin): member and viewer
 * get 403 on every secret-token operation, including list. The settings UI
 * only hides creation/revocation controls that would deterministically 403
 * and renders the 403 list state gracefully.
 */
export function canManageSecretTokens(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Block 6 issue affordances. Member and up manage issues; viewers read.
 * Mirrors the API `issue:*` capabilities — the backend enforces, the UI
 * only hides controls that would deterministically 403.
 */
export function canUpdateIssueStatus(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function canAssignIssue(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function canManageIssueTags(role: WorkspaceRole): boolean {
  return role !== "viewer";
}

export function canCommentOnIssue(role: WorkspaceRole): boolean {
  return role !== "viewer";
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
