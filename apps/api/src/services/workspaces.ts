import { normalizeWorkspaceSlug } from "@replaybug/contracts";
import {
  AuditRepo,
  MembershipRepo,
  UserRepo,
  WorkspaceRepo,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import {
  conflict,
  isUniqueViolation,
  notFound,
  validationError,
} from "../errors.js";
import {
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import type { WorkspaceMember, WorkspaceRole } from "@replaybug/contracts";
import { toWorkspaceDto, toWorkspaceWithRoleDto } from "./dto.js";

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
}

function resolveSlug(name: string, explicit?: string): string {
  const raw =
    explicit !== undefined && explicit.trim() !== "" ? explicit : name;
  const slug = normalizeWorkspaceSlug(raw);
  if (slug.length < 2 || slug.length > 100) {
    throw validationError(
      "Workspace slug must be 2-100 chars after normalization",
    );
  }
  return slug;
}

export async function createWorkspace(
  db: Database,
  actorUserId: string,
  input: CreateWorkspaceInput,
): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw validationError("Workspace name is required");
  }
  const slug = resolveSlug(name, input.slug);
  try {
    const created = await db.transaction(async (tx: DbTransaction) => {
      const ws = await WorkspaceRepo.insertWorkspace(tx, {
        name,
        slug,
        createdByUserId: actorUserId,
      });
      await MembershipRepo.insertMembership(tx, {
        workspaceId: ws.id,
        userId: actorUserId,
        role: "owner",
      });
      await AuditRepo.insertAuditLog(tx, {
        workspaceId: ws.id,
        actorUserId,
        action: "workspace.created",
        metadataJson: { workspaceId: ws.id, slug: ws.slug, name: ws.name },
      });
      return ws;
    });
    return toWorkspaceDto(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Workspace slug already exists");
    }
    throw error;
  }
}

export async function listMyWorkspaces(
  db: Database,
  userId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    updatedAt: string;
    role: WorkspaceRole;
  }>
> {
  const memberships = await MembershipRepo.listMembershipsByUser(db, userId);
  const out: Array<{
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    updatedAt: string;
    role: WorkspaceRole;
  }> = [];
  for (const m of memberships) {
    const ws = await WorkspaceRepo.findWorkspaceById(db, m.workspaceId);
    if (ws === undefined) {
      continue;
    }
    const role = m.role as WorkspaceRole;
    out.push(toWorkspaceWithRoleDto(ws, role));
  }
  return out;
}

export async function getWorkspace(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  role: WorkspaceRole;
}> {
  const membership = await MembershipRepo.findMembership(
    db,
    workspaceId,
    userId,
  );
  const checked = requireWorkspaceMembership(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
  );
  const ws = await WorkspaceRepo.findWorkspaceById(db, workspaceId);
  if (ws === undefined) {
    throw notFound("Workspace");
  }
  return toWorkspaceWithRoleDto(ws, checked.role);
}

/**
 * Workspace member listing: read-only minimum (id/name/email/role) for
 * assignment pickers. Members-only read (any role, anti-enumeration
 * NOT_FOUND for outsiders). No invite/remove/role changes in Block 6.
 */
export async function listWorkspaceMembers(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const membership = await MembershipRepo.findMembership(
    db,
    workspaceId,
    userId,
  );
  requireWorkspaceMembership(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
  );
  const memberships = await MembershipRepo.listMembershipsByWorkspace(
    db,
    workspaceId,
  );
  const usersById = await UserRepo.findUsersByIds(
    db,
    memberships.map((m) => m.userId),
  );
  return memberships
    .map((m) => {
      const user = usersById.get(m.userId);
      if (user === undefined) {
        return null;
      }
      const role = m.role as WorkspaceRole;
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        role:
          role === "owner" ||
          role === "admin" ||
          role === "member" ||
          role === "viewer"
            ? role
            : ("viewer" as const),
      } satisfies WorkspaceMember;
    })
    .filter((m): m is WorkspaceMember => m !== null)
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function updateWorkspace(
  db: Database,
  userId: string,
  workspaceId: string,
  patch: { name?: string; slug?: string },
): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}> {
  const membership = await MembershipRepo.findMembership(
    db,
    workspaceId,
    userId,
  );
  const checked = requireWorkspaceMembership(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
  );
  requireWorkspaceCapability(checked, "workspace:update");

  const normalizedPatch: { name?: string; slug?: string } = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) {
      throw validationError("Workspace name must not be empty");
    }
    normalizedPatch.name = name;
  }
  if (patch.slug !== undefined) {
    normalizedPatch.slug = resolveSlug(patch.name ?? "x", patch.slug);
  }
  try {
    const updated = await db.transaction(async (tx: DbTransaction) => {
      const row = await WorkspaceRepo.updateWorkspaceRow(
        tx,
        workspaceId,
        normalizedPatch,
      );
      if (row === undefined) {
        throw notFound("Workspace");
      }
      await AuditRepo.insertAuditLog(tx, {
        workspaceId,
        actorUserId: userId,
        action: "workspace.updated",
        metadataJson: { workspaceId, patch: normalizedPatch },
      });
      return row;
    });
    return toWorkspaceDto(updated);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: string }).code === undefined &&
      isUniqueViolation(error)
    ) {
      throw conflict("Workspace slug already exists");
    }
    if (isUniqueViolation(error)) {
      throw conflict("Workspace slug already exists");
    }
    throw error;
  }
}
