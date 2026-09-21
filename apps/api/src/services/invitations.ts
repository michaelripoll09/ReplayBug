import {
  AuditRepo,
  InvitationRepo,
  MembershipRepo,
  UserRepo,
  WorkspaceRepo,
  InvitationEmailError,
  InvitationRoleError,
  InvitationTokenError,
  generateInvitationToken,
  lockActiveInvitationByWorkspaceEmail,
  markInvitationAccepted,
  markInvitationRevoked,
  normalizeInvitationEmail,
  parseInvitationToken,
  retireExpiredPendingInvitations,
  validateInvitationRole,
  verifyInvitationToken,
  type Database,
  type DbTransaction,
  type InvitationRole,
} from "@replaybug/db";
import type {
  CreateWorkspaceInvitationRequest,
  CreateWorkspaceInvitationResponse,
  WorkspaceInvitation,
  WorkspaceInvitationAcceptResponse,
  WorkspaceInvitationRole,
  WorkspaceInvitationStatus,
  WorkspaceRole,
} from "@replaybug/contracts";
import {
  activeInvitationExists,
  alreadyWorkspaceMember,
  conflict,
  forbidden,
  invitationAlreadyUsed,
  invitationInvalid,
  isUniqueViolation,
  notFound,
  validationError,
} from "../errors.js";
import {
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import { toWorkspaceInvitationDto } from "./dto.js";

export { getWorkspaceInvitationStatus } from "./dto.js";

export const INVITATION_DELIVERY_NOTE =
  "Email delivery is not configured; securely share this invitation link with the intended recipient.";

function normalizeEmailOrThrow(input: unknown): string {
  try {
    return normalizeInvitationEmail(input);
  } catch (error) {
    if (error instanceof InvitationEmailError) {
      throw validationError(error.message);
    }
    throw error;
  }
}

function invitationRoleOrThrow(input: unknown): InvitationRole {
  try {
    return validateInvitationRole(input);
  } catch (error) {
    if (error instanceof InvitationRoleError) {
      throw validationError(error.message);
    }
    throw error;
  }
}

/** Owner may grant every non-owner role; admin may grant member/viewer only. */
export function canInviteInvitationRole(
  actorRole: WorkspaceRole,
  invitedRole: WorkspaceInvitationRole | WorkspaceRole,
): boolean {
  if (
    invitedRole === "owner" ||
    actorRole === "member" ||
    actorRole === "viewer"
  ) {
    return false;
  }
  if (actorRole === "owner") {
    return true;
  }
  return (
    actorRole === "admin" &&
    (invitedRole === "member" || invitedRole === "viewer")
  );
}

export function buildInvitationUrl(baseUrl: string, token: string): string {
  const base = new URL(baseUrl);
  base.search = "";
  base.hash = "";
  const pathname = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${pathname}/invite/${encodeURIComponent(token)}`;
  return base.toString();
}

async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const membership = await MembershipRepo.findMembership(
    db,
    workspaceId,
    userId,
  );
  return requireWorkspaceMembership(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
  );
}

async function requireInvitationManagement(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const membership = await membershipOrThrow(db, workspaceId, userId);
  requireWorkspaceCapability(membership, "workspace:manage-invitations");
  return membership;
}

function auditMetadata(values: {
  invitationId: string;
  workspaceId: string;
  email: string;
  role: string;
  actorId: string;
}): Record<string, unknown> {
  return {
    invitationId: values.invitationId,
    workspaceId: values.workspaceId,
    email: values.email,
    role: values.role,
    actorId: values.actorId,
  };
}

export function createInvitationResponse(
  row: InvitationRepo.InvitationRow,
  token: string,
  webUrl: string,
  now = new Date(),
): CreateWorkspaceInvitationResponse {
  return {
    ...toWorkspaceInvitationDto(row, now),
    token,
    inviteUrl: buildInvitationUrl(webUrl, token),
    deliveryNote: INVITATION_DELIVERY_NOTE,
  };
}

export async function createWorkspaceInvitation(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  input: CreateWorkspaceInvitationRequest | { email: unknown; role: unknown },
  webUrl = "http://localhost:3000",
): Promise<CreateWorkspaceInvitationResponse> {
  const authorization = await requireInvitationManagement(
    db,
    workspaceId,
    actorUserId,
  );
  const email = normalizeEmailOrThrow(input.email);
  const role = invitationRoleOrThrow(input.role);
  if (!canInviteInvitationRole(authorization.role, role)) {
    throw forbidden("Insufficient workspace role");
  }

  const now = new Date();
  const result = await db.transaction(async (tx: DbTransaction) => {
    const lockedActor = await MembershipRepo.lockMembership(
      tx,
      workspaceId,
      actorUserId,
    );
    const checkedActor = requireWorkspaceMembership(
      lockedActor === undefined
        ? undefined
        : {
            workspaceId: lockedActor.workspaceId,
            userId: lockedActor.userId,
            role: lockedActor.role as WorkspaceRole,
          },
    );
    requireWorkspaceCapability(checkedActor, "workspace:manage-invitations");

    await retireExpiredPendingInvitations(tx, {
      workspaceId,
      email,
      now,
      limit: 20,
    });

    const targetUser = await UserRepo.findUserByEmail(tx, email);
    if (targetUser !== undefined) {
      const lockedTarget = await UserRepo.lockUserById(tx, targetUser.id);
      if (lockedTarget === undefined) {
        throw alreadyWorkspaceMember();
      }
      const targetMembership = await MembershipRepo.lockMembership(
        tx,
        workspaceId,
        lockedTarget.id,
      );
      if (targetMembership !== undefined) {
        throw alreadyWorkspaceMember();
      }
    }

    const active = await lockActiveInvitationByWorkspaceEmail(
      tx,
      workspaceId,
      email,
      now,
    );
    if (active !== undefined) {
      throw activeInvitationExists();
    }

    let created: InvitationRepo.InvitationRow | undefined;
    let plaintext = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = generateInvitationToken(now);
      try {
        created = await InvitationRepo.insertInvitation(tx, {
          workspaceId,
          email,
          role,
          tokenHash: generated.tokenHash,
          tokenPrefix: generated.tokenPrefix,
          expiresAt: generated.expiresAt,
          createdByUserId: actorUserId,
        });
        plaintext = generated.token;
        break;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const duplicate = await lockActiveInvitationByWorkspaceEmail(
          tx,
          workspaceId,
          email,
          now,
        );
        if (duplicate !== undefined) {
          throw activeInvitationExists();
        }
        if (attempt === 2) {
          throw conflict("Unable to create workspace invitation");
        }
      }
    }
    if (created === undefined || plaintext === "") {
      throw new Error("Failed to create workspace invitation");
    }

    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace_invitation.created",
      metadataJson: auditMetadata({
        invitationId: created.id,
        workspaceId,
        email: created.email,
        role: created.role,
        actorId: actorUserId,
      }),
    });
    return { row: created, token: plaintext };
  });

  return createInvitationResponse(result.row, result.token, webUrl, now);
}

export async function listWorkspaceInvitations(
  db: Database,
  actorUserId: string,
  workspaceId: string,
): Promise<WorkspaceInvitation[]> {
  await requireInvitationManagement(db, workspaceId, actorUserId);
  const now = new Date();
  const rows = await InvitationRepo.listInvitationMetadataByWorkspace(
    db,
    workspaceId,
  );
  return rows.map((row) => toWorkspaceInvitationDto(row, now));
}

export async function revokeWorkspaceInvitation(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  invitationId: string,
): Promise<WorkspaceInvitation> {
  await requireInvitationManagement(db, workspaceId, actorUserId);
  const now = new Date();
  const row = await db.transaction(async (tx: DbTransaction) => {
    const invitation = await InvitationRepo.lockInvitationById(
      tx,
      invitationId,
    );
    if (invitation === undefined || invitation.workspaceId !== workspaceId) {
      throw notFound("Invitation");
    }
    if (invitation.acceptedAt !== null) {
      throw conflict("Accepted invitations cannot be revoked");
    }
    if (
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= now.getTime()
    ) {
      return invitation;
    }
    const revoked = await markInvitationRevoked(tx, invitation.id, now);
    if (revoked === undefined) {
      return invitation;
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId,
      actorUserId,
      action: "workspace_invitation.revoked",
      metadataJson: auditMetadata({
        invitationId: revoked.id,
        workspaceId,
        email: revoked.email,
        role: revoked.role,
        actorId: actorUserId,
      }),
    });
    return revoked;
  });
  return toWorkspaceInvitationDto(row, now);
}

export async function acceptWorkspaceInvitation(
  db: Database,
  actorUserId: string,
  actorEmail: string,
  token: string,
): Promise<WorkspaceInvitationAcceptResponse> {
  let parsedToken: ReturnType<typeof parseInvitationToken>;
  try {
    parsedToken = parseInvitationToken(token);
  } catch (error) {
    if (error instanceof InvitationTokenError) {
      throw invitationInvalid();
    }
    throw error;
  }
  const normalizedActorEmail = normalizeEmailOrInvitationInvalid(actorEmail);

  return db.transaction(async (tx: DbTransaction) => {
    const candidates =
      await InvitationRepo.lockInvitationCandidatesByTokenPrefix(
        tx,
        parsedToken.tokenPrefix,
      );
    let matched: InvitationRepo.InvitationTokenLookupRow | undefined;
    for (const candidate of candidates) {
      if (verifyInvitationToken(parsedToken.token, candidate.tokenHash)) {
        matched = candidate;
      }
    }
    if (matched === undefined) {
      throw invitationInvalid();
    }
    if (matched.acceptedAt !== null) {
      throw invitationAlreadyUsed();
    }
    const now = new Date();
    if (
      matched.revokedAt !== null ||
      matched.expiresAt.getTime() <= now.getTime() ||
      normalizedActorEmail !== matched.email
    ) {
      throw invitationInvalid();
    }

    const workspace = await WorkspaceRepo.findWorkspaceById(
      tx,
      matched.workspaceId,
    );
    if (workspace === undefined) {
      throw invitationInvalid();
    }
    const authenticatedUser = await UserRepo.lockUserById(tx, actorUserId);
    if (authenticatedUser === undefined) {
      throw invitationInvalid();
    }
    if (
      normalizeEmailOrInvitationInvalid(authenticatedUser.email) !==
      normalizedActorEmail
    ) {
      throw invitationInvalid();
    }
    const existingMembership = await MembershipRepo.lockMembership(
      tx,
      matched.workspaceId,
      actorUserId,
    );
    if (existingMembership !== undefined) {
      throw alreadyWorkspaceMember();
    }

    let membership: Awaited<ReturnType<typeof MembershipRepo.insertMembership>>;
    try {
      membership = await MembershipRepo.insertMembership(tx, {
        workspaceId: matched.workspaceId,
        userId: actorUserId,
        role: matched.role,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw alreadyWorkspaceMember();
      }
      throw error;
    }
    const accepted = await markInvitationAccepted(tx, matched.id, now);
    if (accepted === undefined) {
      throw invitationAlreadyUsed();
    }
    const role = invitationRoleOrThrow(accepted.role);
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: accepted.workspaceId,
      actorUserId,
      action: "workspace_invitation.accepted",
      metadataJson: auditMetadata({
        invitationId: accepted.id,
        workspaceId: accepted.workspaceId,
        email: accepted.email,
        role,
        actorId: actorUserId,
      }),
    });
    return {
      invitationId: accepted.id,
      workspaceId: accepted.workspaceId,
      membershipId: membership.id,
      role,
      acceptedAt: accepted.acceptedAt?.toISOString() ?? now.toISOString(),
    };
  });
}

function normalizeEmailOrInvitationInvalid(input: unknown): string {
  try {
    return normalizeInvitationEmail(input);
  } catch (error) {
    if (error instanceof InvitationEmailError) {
      throw invitationInvalid();
    }
    throw error;
  }
}

export type InvitationStatus = WorkspaceInvitationStatus;
