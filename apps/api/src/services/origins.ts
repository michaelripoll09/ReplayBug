import {
  AuditRepo,
  MembershipRepo,
  OriginRepo,
  ProjectRepo,
  parseOrigin,
  OriginParseError,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import type { WorkspaceRole } from "@replaybug/contracts";
import {
  conflict,
  isUniqueViolation,
  notFound,
  validationError,
} from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import { toOriginDto } from "./dto.js";

async function projectAndMembership(
  db: Database,
  userId: string,
  projectId: string,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const m = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  const checked = requireProjectAccess(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
    { id: project.id, workspaceId: project.workspaceId },
  );
  return { workspaceId: project.workspaceId, role: checked.role };
}

export async function addOrigin(
  db: Database,
  userId: string,
  projectId: string,
  input: { origin: string; isEnabled?: boolean },
): Promise<ReturnType<typeof toOriginDto>> {
  const { workspaceId, role } = await projectAndMembership(
    db,
    userId,
    projectId,
  );
  requireWorkspaceCapability({ workspaceId, userId, role }, "origin:write");

  let normalized: string;
  try {
    normalized = parseOrigin(input.origin);
  } catch (e) {
    if (e instanceof OriginParseError) {
      throw validationError(e.message);
    }
    throw e;
  }

  try {
    const created = await db.transaction(async (tx: DbTransaction) => {
      const row = await OriginRepo.insertOrigin(tx, {
        projectId,
        origin: normalized,
        isEnabled: input.isEnabled ?? true,
      });
      await AuditRepo.insertAuditLog(tx, {
        workspaceId,
        projectId,
        actorUserId: userId,
        action: "project_origin.created",
        metadataJson: { projectId, origin: normalized },
      });
      return row;
    });
    return toOriginDto(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Origin already registered for this project");
    }
    throw error;
  }
}

export async function updateOrigin(
  db: Database,
  userId: string,
  originId: string,
  patch: { origin?: string; isEnabled?: boolean },
): Promise<ReturnType<typeof toOriginDto>> {
  const existing = await OriginRepo.findOriginById(db, originId);
  if (existing === undefined) {
    throw notFound("Origin");
  }
  const project = await ProjectRepo.findProjectById(db, existing.projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const m = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  const checked = requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
  requireProjectAccess(checked, {
    id: project.id,
    workspaceId: project.workspaceId,
  });
  requireWorkspaceCapability(checked, "origin:write");

  const normalizedPatch: { origin?: string; isEnabled?: boolean } = {};
  if (patch.origin !== undefined) {
    try {
      normalizedPatch.origin = parseOrigin(patch.origin);
    } catch (e) {
      if (e instanceof OriginParseError) {
        throw validationError(e.message);
      }
      throw e;
    }
  }
  if (patch.isEnabled !== undefined) {
    normalizedPatch.isEnabled = patch.isEnabled;
  }

  try {
    const updated = await db.transaction(async (tx: DbTransaction) => {
      const row = await OriginRepo.updateOriginRow(
        tx,
        originId,
        normalizedPatch,
      );
      if (row === undefined) {
        throw notFound("Origin");
      }
      await AuditRepo.insertAuditLog(tx, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        actorUserId: userId,
        action: "project_origin.updated",
        metadataJson: {
          projectId: project.id,
          originId,
          patch: normalizedPatch,
        },
      });
      return row;
    });
    return toOriginDto(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Origin already registered for this project");
    }
    throw error;
  }
}

export async function removeOrigin(
  db: Database,
  userId: string,
  originId: string,
): Promise<{ deleted: boolean }> {
  const existing = await OriginRepo.findOriginById(db, originId);
  if (existing === undefined) {
    return { deleted: false };
  }
  const project = await ProjectRepo.findProjectById(db, existing.projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const m = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  const checked = requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
  requireProjectAccess(checked, {
    id: project.id,
    workspaceId: project.workspaceId,
  });
  requireWorkspaceCapability(checked, "origin:write");

  await db.transaction(async (tx: DbTransaction) => {
    await OriginRepo.deleteOriginRow(tx, originId);
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      actorUserId: userId,
      action: "project_origin.deleted",
      metadataJson: {
        projectId: project.id,
        originId,
        origin: existing.origin,
      },
    });
  });
  return { deleted: true };
}
