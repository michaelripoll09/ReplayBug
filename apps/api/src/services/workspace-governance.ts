import {
  AuditRepo,
  MembershipRepo,
  UserRepo,
  WorkspaceRepo,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import {
  workspaceMemberRoleSchema,
  type LeaveWorkspaceResponse,
  type RemoveWorkspaceMemberResponse,
  type TransferWorkspaceOwnershipRequest,
  type TransferWorkspaceOwnershipResponse,
  type UpdateWorkspaceMemberRoleRequest,
  type WorkspaceAuditPage,
  type WorkspaceAuditQuery,
  type WorkspaceMember,
  type WorkspaceRole,
} from "@replaybug/contracts";
import {
  canChangeMemberRole,
  canLeaveWorkspace,
  canRemoveMember,
} from "../authz/policy.js";
import { conflict, forbidden, notFound, validationError } from "../errors.js";
import {
  requireWorkspaceCapability,
  requireWorkspaceMembership,
  type MembershipView,
} from "../authz/guards.js";
import { toAuditEventDto, toWorkspaceMemberDto } from "./dto.js";

function persistedWorkspaceRole(value: string): WorkspaceRole {
  if (
    value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "viewer"
  ) {
    return value;
  }
  throw new Error("Invalid persisted workspace role");
}

function membershipView(row: MembershipRepo.MembershipRow): MembershipView {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: persistedWorkspaceRole(row.role),
  };
}

function membershipForUser(
  memberships: readonly MembershipRepo.MembershipRow[],
  userId: string,
): MembershipRepo.MembershipRow | undefined {
  return memberships.find((membership) => membership.userId === userId);
}

function actorMembershipOrThrow(
  memberships: readonly MembershipRepo.MembershipRow[],
  userId: string,
): MembershipView {
  const membership = membershipForUser(memberships, userId);
  return requireWorkspaceMembership(
    membership === undefined ? undefined : membershipView(membership),
  );
}

function targetMembershipOrThrow(
  memberships: readonly MembershipRepo.MembershipRow[],
  userId: string,
): MembershipRepo.MembershipRow {
  const target = membershipForUser(memberships, userId);
  if (target === undefined) {
    throw notFound("Workspace member");
  }
  return target;
}

function requireExactlyOneOwner(
  memberships: readonly MembershipRepo.MembershipRow[],
): MembershipRepo.MembershipRow {
  const owners = memberships.filter(
    (membership) => persistedWorkspaceRole(membership.role) === "owner",
  );
  if (owners.length !== 1) {
    throw conflict("Workspace must have exactly one owner");
  }
  const owner = owners[0];
  if (owner === undefined) {
    throw conflict("Workspace must have exactly one owner");
  }
  return owner;
}

/**
 * Every governance mutation locks the workspace first, then every membership
 * in deterministic id order. Actor and target roles are therefore read from
 * the same locked snapshot rather than from a pre-transaction authorization
 * check.
 */
async function lockGovernanceState(
  tx: DbTransaction,
  workspaceId: string,
): Promise<MembershipRepo.MembershipRow[]> {
  const workspace = await WorkspaceRepo.lockWorkspaceById(tx, workspaceId);
  if (workspace === undefined) {
    throw notFound("Workspace");
  }
  return MembershipRepo.lockMembershipsByWorkspace(tx, workspace.id);
}

async function memberDto(
  db: Database,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  const users = await UserRepo.findUsersByIds(db, [userId]);
  const user = users.get(userId);
  if (user === undefined) {
    throw new Error("Workspace membership refers to a missing user");
  }
  return toWorkspaceMemberDto(user, role);
}

export async function updateWorkspaceMemberRole(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
  input: UpdateWorkspaceMemberRoleRequest,
): Promise<WorkspaceMember> {
  const requestedRole = workspaceMemberRoleSchema.safeParse(input.role);
  if (!requestedRole.success) {
    throw validationError("Invalid workspace member role");
  }
  const result = await db.transaction(async (tx: DbTransaction) => {
    const memberships = await lockGovernanceState(tx, workspaceId);
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "workspace:manage-members");
    const target = targetMembershipOrThrow(memberships, targetUserId);
    requireExactlyOneOwner(memberships);
    const targetRole = persistedWorkspaceRole(target.role);
    if (!canChangeMemberRole(actor.role, targetRole, requestedRole.data)) {
      throw forbidden("Insufficient workspace role for this member");
    }
    if (targetRole === requestedRole.data) {
      return { userId: target.userId, role: targetRole };
    }
    const updated = await MembershipRepo.updateMembershipRole(
      tx,
      workspaceId,
      targetUserId,
      requestedRole.data,
    );
    if (updated === undefined) {
      throw conflict("Workspace membership changed concurrently");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace_member.role_changed",
      metadataJson: {
        targetUserId,
        previousRole: targetRole,
        role: requestedRole.data,
      },
    });
    return {
      userId: updated.userId,
      role: persistedWorkspaceRole(updated.role),
    };
  });

  return memberDto(db, result.userId, result.role);
}

export async function removeWorkspaceMember(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
): Promise<RemoveWorkspaceMemberResponse> {
  return db.transaction(async (tx: DbTransaction) => {
    const memberships = await lockGovernanceState(tx, workspaceId);
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "workspace:manage-members");
    const target = targetMembershipOrThrow(memberships, targetUserId);
    const owner = requireExactlyOneOwner(memberships);
    const targetRole = persistedWorkspaceRole(target.role);
    if (!canRemoveMember(actor.role, targetRole)) {
      throw forbidden("Insufficient workspace role for this member");
    }
    if (target.userId === owner.userId) {
      throw forbidden("The workspace owner cannot be removed");
    }
    const removed = await MembershipRepo.deleteMembership(
      tx,
      workspaceId,
      targetUserId,
    );
    if (removed === undefined) {
      throw conflict("Workspace membership changed concurrently");
    }
    const remainingOwners = memberships.filter(
      (membership) =>
        membership.id !== removed.id &&
        persistedWorkspaceRole(membership.role) === "owner",
    );
    if (remainingOwners.length !== 1) {
      throw conflict("Workspace must have exactly one owner");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace_member.removed",
      metadataJson: { targetUserId, role: targetRole, reason: "removed" },
    });
    return { removed: true };
  });
}

export async function leaveWorkspace(
  db: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<LeaveWorkspaceResponse> {
  return db.transaction(async (tx: DbTransaction) => {
    const memberships = await lockGovernanceState(tx, workspaceId);
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    if (!canLeaveWorkspace(actor.role)) {
      throw forbidden("Insufficient workspace role");
    }
    const owner = requireExactlyOneOwner(memberships);
    if (owner.userId === actorUserId) {
      throw conflict("The last workspace owner cannot leave");
    }
    const removed = await MembershipRepo.deleteMembership(
      tx,
      workspaceId,
      actorUserId,
    );
    if (removed === undefined) {
      throw conflict("Workspace membership changed concurrently");
    }
    const remainingOwners = memberships.filter(
      (membership) =>
        membership.id !== removed.id &&
        persistedWorkspaceRole(membership.role) === "owner",
    );
    if (remainingOwners.length !== 1) {
      throw conflict("Workspace must have exactly one owner");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace_member.removed",
      metadataJson: {
        targetUserId: actorUserId,
        role: actor.role,
        reason: "left",
      },
    });
    return { left: true };
  });
}

export async function transferWorkspaceOwnership(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  input: TransferWorkspaceOwnershipRequest,
): Promise<TransferWorkspaceOwnershipResponse> {
  return db.transaction(async (tx: DbTransaction) => {
    const memberships = await lockGovernanceState(tx, workspaceId);
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "workspace:transfer-ownership");
    const owner = requireExactlyOneOwner(memberships);
    if (owner.userId !== actor.userId) {
      throw forbidden("Only the workspace owner can transfer ownership");
    }
    const target = targetMembershipOrThrow(memberships, input.userId);
    const targetRole = persistedWorkspaceRole(target.role);
    if (targetRole === "owner") {
      throw conflict("Ownership target must be a non-owner member");
    }

    const previousOwner = await MembershipRepo.updateMembershipRole(
      tx,
      workspaceId,
      owner.userId,
      "admin",
    );
    const newOwner = await MembershipRepo.updateMembershipRole(
      tx,
      workspaceId,
      target.userId,
      "owner",
    );
    if (previousOwner === undefined || newOwner === undefined) {
      throw conflict("Workspace membership changed concurrently");
    }

    const after = await MembershipRepo.listMembershipsByWorkspace(
      tx,
      workspaceId,
    );
    const resultingOwner = requireExactlyOneOwner(after);
    if (resultingOwner.userId !== target.userId) {
      throw conflict("Workspace must have exactly one owner");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace.ownership_transferred",
      metadataJson: {
        previousOwnerId: owner.userId,
        newOwnerId: target.userId,
      },
    });
    return {
      workspaceId,
      previousOwnerId: owner.userId,
      newOwnerId: target.userId,
    };
  });
}

export async function listWorkspaceAudit(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  query: WorkspaceAuditQuery,
): Promise<WorkspaceAuditPage> {
  return db.transaction(async (tx: DbTransaction) => {
    const memberships = await lockGovernanceState(tx, workspaceId);
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "workspace:read-audit");

    let cursor: AuditRepo.AuditCursor | undefined;
    if (query.cursor !== undefined) {
      const decoded = AuditRepo.decodeAuditCursor(query.cursor);
      if (decoded === null) {
        throw validationError("Invalid pagination cursor");
      }
      cursor = decoded;
    }
    const result = await AuditRepo.listAuditByWorkspacePaged(tx, {
      workspaceId,
      limit: query.limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(query.action === undefined ? {} : { action: query.action }),
    });
    const actorIds = result.rows.flatMap((row) =>
      row.actorUserId === null ? [] : [row.actorUserId],
    );
    const users = await UserRepo.findUsersByIds(tx, actorIds);
    const items = result.rows.map((row) =>
      toAuditEventDto(
        row,
        row.actorUserId === null ? null : (users.get(row.actorUserId) ?? null),
      ),
    );
    return result.nextCursor === null
      ? { items }
      : { items, nextCursor: result.nextCursor };
  });
}
