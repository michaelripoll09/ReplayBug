import {
  AuditRepo,
  MembershipRepo,
  ProjectKeyRepo,
  ProjectRepo,
  generatePublicKey,
  hashPublicKey,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import type { WorkspaceRole } from "@replaybug/contracts";
import { isUniqueViolation, notFound } from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import { toKeyMetaDto } from "./dto.js";

/** Rotate the public ingest key: revoke old actives + create new + audit in one tx. Old rows are retained auditable. */
export async function rotatePublicIngestKey(
  db: Database,
  userId: string,
  projectId: string,
): Promise<{
  id: string;
  projectId: string;
  kind: "public_ingest";
  name: string;
  prefix: string;
  key: string;
  createdAt: string;
}> {
  const project = await ProjectRepo.findProjectById(db, projectId);
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
  requireWorkspaceCapability(checked, "key:rotate");

  const now = new Date();
  const result = await db.transaction(async (tx: DbTransaction) => {
    const actives = await ProjectKeyRepo.listActiveKeysByProjectAndKind(
      tx,
      projectId,
      "public_ingest",
    );
    for (const active of actives) {
      await ProjectKeyRepo.revokeKeyById(tx, active.id, now);
    }
    let created:
      Awaited<ReturnType<typeof ProjectKeyRepo.insertProjectKey>> | undefined;
    let fullKey = "";
    let prefix = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = generatePublicKey();
      try {
        const keyHash = hashPublicKey(generated.fullKey);
        created = await ProjectKeyRepo.insertProjectKey(tx, {
          projectId,
          kind: "public_ingest",
          name: `rotated-${now.toISOString().slice(0, 10)}`,
          prefix: generated.prefix,
          keyHash,
        });
        fullKey = generated.fullKey;
        prefix = generated.prefix;
        break;
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 2) {
          continue;
        }
        throw e;
      }
    }
    if (created === undefined || fullKey === "") {
      throw new Error("Failed to rotate project key");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: project.workspaceId,
      projectId,
      actorUserId: userId,
      action: "project_key.rotated",
      metadataJson: {
        projectId,
        newKeyId: created.id,
        newPrefix: prefix,
        revokedCount: actives.length,
      },
    });
    return { created, fullKey, prefix };
  });

  return {
    id: result.created.id,
    projectId,
    kind: "public_ingest",
    name: result.created.name,
    prefix: result.prefix,
    key: result.fullKey,
    createdAt: result.created.createdAt.toISOString(),
  };
}

export async function listKeyMetadata(
  db: Database,
  userId: string,
  projectId: string,
): Promise<ReturnType<typeof toKeyMetaDto>[]> {
  const project = await ProjectRepo.findProjectById(db, projectId);
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
  requireWorkspaceCapability(checked, "key:read");
  const rows = await ProjectKeyRepo.listKeysByProject(db, projectId);
  return rows.map(toKeyMetaDto);
}
