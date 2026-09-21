import type { WorkspaceRole } from "@replaybug/contracts";
import { DomainError, authRequired, forbidden, notFound } from "../errors.js";
import { hasCapability, type Capability } from "./policy.js";

/**
 * Server-side authz helpers. Pure/testable without Fastify: they operate on
 * explicit session + membership inputs, never on Request/Reply.
 * Anti-enumeration: cross-tenant access returns NOT_FOUND, not FORBIDDEN,
 * so callers cannot probe for resource existence.
 */

export interface SessionUser {
  id: string;
  email: string;
}

export interface MembershipView {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface ProjectView {
  id: string;
  workspaceId: string;
}

export function requireAuthenticatedUser(
  user: SessionUser | null | undefined,
): SessionUser {
  if (user === null || user === undefined) {
    throw authRequired();
  }
  return user;
}

export function requireWorkspaceMembership(
  membership: MembershipView | null | undefined,
): MembershipView {
  // Missing membership is reported as NOT_FOUND to avoid revealing whether
  // the workspace exists (anti-enumeration).
  if (membership === null || membership === undefined) {
    throw notFound("Workspace");
  }
  return membership;
}

export function requireWorkspaceCapability(
  membership: MembershipView,
  capability: Capability,
): void {
  if (!hasCapability(membership.role, capability)) {
    // Authenticated but under-privileged inside a known workspace: 403.
    throw forbidden("Insufficient workspace role");
  }
}

export function requireWorkspaceRole(
  membership: MembershipView,
  allowed: readonly WorkspaceRole[],
): void {
  if (!allowed.includes(membership.role)) {
    throw forbidden("Insufficient workspace role");
  }
}

/**
 * Project access via workspace membership (no project-membership system).
 * Returns the membership when the project belongs to the member's workspace.
 * Throws NOT_FOUND when the project is in another workspace (anti-enumeration)
 * or when there is no membership.
 */
export function requireProjectAccess(
  membership: MembershipView | null | undefined,
  project: ProjectView | null | undefined,
): MembershipView {
  if (
    project === null ||
    project === undefined ||
    membership === null ||
    membership === undefined
  ) {
    throw notFound("Project");
  }
  if (membership.workspaceId !== project.workspaceId) {
    throw notFound("Project");
  }
  return membership;
}

export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  return new DomainError("INTERNAL_ERROR", "An unexpected error occurred");
}
