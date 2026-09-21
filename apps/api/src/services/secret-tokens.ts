import {
  AuditRepo,
  MembershipRepo,
  ProjectKeyRepo,
  ProjectRepo,
  generateSecretToken,
  hashSecretToken,
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
import { toKeyMetaDto } from "./dto.js";

/**
 * RS-02 secret project tokens: project-scoped `rb_sk_…` CLI credentials
 * stored as hash+prefix in the shared `project_keys` table (kind `secret`).
 * The full token is returned exactly once at creation and never logged,
 * re-displayed or audited. All three operations require the centralized
 * `project:manage-secret-tokens` capability (owner/admin only).
 */

const SECRET_TOKEN_NAME_MAX = 100;
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function validateSecretTokenName(input: unknown): string {
  if (typeof input !== "string") {
    throw validationError("Secret token name must be a string");
  }
  const name = input.trim();
  if (name.length === 0) {
    throw validationError("Secret token name is required");
  }
  if (name.length > SECRET_TOKEN_NAME_MAX) {
    throw validationError(
      `Secret token name must be 1-${SECRET_TOKEN_NAME_MAX} characters`,
    );
  }
  if (hasControlChars(name)) {
    throw validationError("Secret token name contains invalid characters");
  }
  return name;
}

async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const m = await MembershipRepo.findMembership(db, workspaceId, userId);
  return requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
}

async function authorizeSecretTokenManagement(
  db: Database,
  userId: string,
  projectId: string,
): Promise<{ id: string; workspaceId: string }> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireProjectAccess(membership, {
    id: project.id,
    workspaceId: project.workspaceId,
  });
  requireWorkspaceCapability(membership, "project:manage-secret-tokens");
  return { id: project.id, workspaceId: project.workspaceId };
}

export async function listSecretTokens(
  db: Database,
  userId: string,
  projectId: string,
): Promise<ReturnType<typeof toKeyMetaDto>[]> {
  await authorizeSecretTokenManagement(db, userId, projectId);
  const rows = await ProjectKeyRepo.listKeysByProject(db, projectId);
  return rows
    .filter((row) => row.kind === "secret")
    .map((row) => toKeyMetaDto(row));
}

export async function createSecretToken(
  db: Database,
  userId: string,
  projectId: string,
  input: { name: unknown },
): Promise<ReturnType<typeof toKeyMetaDto> & { token: string }> {
  const authorized = await authorizeSecretTokenManagement(
    db,
    userId,
    projectId,
  );
  const name = validateSecretTokenName(input.name);

  const result = await db.transaction(async (tx: DbTransaction) => {
    let created:
      Awaited<ReturnType<typeof ProjectKeyRepo.insertProjectKey>> | undefined;
    let fullToken = "";
    let prefix = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generated = generateSecretToken();
      try {
        const keyHash = hashSecretToken(generated.fullToken);
        created = await ProjectKeyRepo.insertProjectKey(tx, {
          projectId: authorized.id,
          kind: "secret",
          name,
          prefix: generated.prefix,
          keyHash,
        });
        fullToken = generated.fullToken;
        prefix = generated.prefix;
        break;
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 2) {
          continue;
        }
        throw e;
      }
    }
    if (created === undefined || fullToken === "") {
      throw new Error("Failed to create secret token");
    }
    // Audit carries identifiers only: never the plaintext token or its hash.
    // Metadata keys intentionally avoid sensitive substrings so the audit
    // sanitizer keeps the (non-secret) identifiers readable.
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: authorized.workspaceId,
      projectId: authorized.id,
      actorUserId: userId,
      action: "project_key.rotated",
      metadataJson: {
        projectId: authorized.id,
        identifier: created.id,
        prefix,
        name,
      },
    });
    return { created, fullToken };
  });

  return {
    ...toKeyMetaDto(result.created),
    token: result.fullToken,
  };
}

export async function revokeSecretToken(
  db: Database,
  userId: string,
  projectId: string,
  tokenId: string,
): Promise<ReturnType<typeof toKeyMetaDto>> {
  const authorized = await authorizeSecretTokenManagement(
    db,
    userId,
    projectId,
  );
  const row = await ProjectKeyRepo.findKeyById(db, tokenId);
  if (
    row === undefined ||
    row.projectId !== authorized.id ||
    row.kind !== "secret"
  ) {
    throw notFound("Secret token");
  }
  if (row.revokedAt !== null) {
    throw conflict("Secret token already revoked");
  }
  const now = new Date();
  const revoked = await db.transaction(async (tx: DbTransaction) => {
    const updated = await ProjectKeyRepo.revokeKeyById(tx, row.id, now);
    if (updated === undefined) {
      throw notFound("Secret token");
    }
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: authorized.workspaceId,
      projectId: authorized.id,
      actorUserId: userId,
      action: "project_key.rotated",
      metadataJson: {
        projectId: authorized.id,
        identifier: row.id,
        prefix: row.prefix,
      },
    });
    return updated;
  });
  return toKeyMetaDto(revoked);
}
