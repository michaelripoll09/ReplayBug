import { normalizeProjectSlug } from "@replaybug/contracts";
import {
  AuditRepo,
  EnvironmentRepo,
  MembershipRepo,
  OriginRepo,
  ProjectKeyRepo,
  ProjectRepo,
  generatePublicKey,
  hashPublicKey,
  parseBaseUrl,
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
import { toEnvironmentDto, toProjectDto } from "./dto.js";

const RETENTION_MIN = 7;
const RETENTION_MAX = 365;

function resolveSlug(name: string, explicit?: string): string {
  const raw =
    explicit !== undefined && explicit.trim() !== "" ? explicit : name;
  const slug = normalizeProjectSlug(raw);
  if (slug.length < 2 || slug.length > 100) {
    throw validationError(
      "Project slug must be 2-100 chars after normalization",
    );
  }
  return slug;
}

async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const m = await MembershipRepo.findMembership(db, workspaceId, userId);
  const checked = requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
  return checked;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  description?: string;
  timezone?: string;
  retentionDays?: number;
}

export async function createProject(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  input: CreateProjectInput,
): Promise<{
  project: ReturnType<typeof toProjectDto>;
  bootstrap: {
    key: string;
    prefix: string;
    projectId: string;
    ingestEndpoint: string;
    ingestEnabled: false;
    note: string;
  };
  defaultEnvironment: ReturnType<typeof toEnvironmentDto>;
}> {
  const membership = await membershipOrThrow(db, workspaceId, actorUserId);
  requireWorkspaceCapability(membership, "project:create");

  const name = input.name.trim();
  if (name.length === 0) {
    throw validationError("Project name is required");
  }
  const slug = resolveSlug(name, input.slug);
  const timezone = (input.timezone ?? "UTC").trim() || "UTC";
  const retentionDays = input.retentionDays ?? 30;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < RETENTION_MIN ||
    retentionDays > RETENTION_MAX
  ) {
    throw validationError(
      `retentionDays must be an integer ${RETENTION_MIN}-365`,
    );
  }
  const description = input.description?.trim()
    ? input.description.trim()
    : null;

  try {
    const result = await db.transaction(async (tx: DbTransaction) => {
      const project = await ProjectRepo.insertProject(tx, {
        workspaceId,
        name,
        slug,
        description,
        timezone,
        retentionDays,
      });
      const env = await EnvironmentRepo.insertEnvironment(tx, {
        projectId: project.id,
        name: "production",
        baseUrl: null,
        isDefault: true,
      });
      // Initial public ingest key (one-time plaintext, hash at rest).
      let fullKey = "";
      let prefix = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const generated = generatePublicKey();
        try {
          const keyHash = hashPublicKey(generated.fullKey);
          await ProjectKeyRepo.insertProjectKey(tx, {
            projectId: project.id,
            kind: "public_ingest",
            name: "default",
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
      if (fullKey === "") {
        throw new Error("Failed to create project key");
      }
      await AuditRepo.insertAuditLog(tx, {
        workspaceId,
        projectId: project.id,
        actorUserId,
        action: "project.created",
        metadataJson: {
          projectId: project.id,
          slug: project.slug,
          name: project.name,
          keyPrefix: prefix,
        },
      });
      return { project, env, fullKey, prefix };
    });
    return {
      project: toProjectDto(result.project),
      defaultEnvironment: toEnvironmentDto(result.env),
      bootstrap: {
        key: result.fullKey,
        prefix: result.prefix,
        projectId: result.project.id,
        ingestEndpoint: "/api/ingest (FUTURE — non-functional in this block)",
        ingestEnabled: false as const,
        note: "Public ingest keys are FUTURE write-only credentials. Event ingest is not built in this block; store this key securely, it is never shown again.",
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Project slug already exists in this workspace");
    }
    throw error;
  }
}

export async function listProjects(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<ReturnType<typeof toProjectDto>[]> {
  const membership = await membershipOrThrow(db, workspaceId, userId);
  requireWorkspaceCapability(membership, "project:read");
  const rows = await ProjectRepo.listProjectsByWorkspace(db, workspaceId);
  return rows.map(toProjectDto);
}

export async function getProjectById(
  db: Database,
  userId: string,
  projectId: string,
): Promise<ReturnType<typeof toProjectDto>> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  requireProjectAccess(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
    { id: project.id, workspaceId: project.workspaceId },
  );
  return toProjectDto(project);
}

export async function updateProject(
  db: Database,
  userId: string,
  projectId: string,
  patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    timezone?: string;
    retentionDays?: number;
  },
): Promise<ReturnType<typeof toProjectDto>> {
  const existing = await ProjectRepo.findProjectById(db, projectId);
  if (existing === undefined) {
    throw notFound("Project");
  }
  const membership = await membershipOrThrow(db, existing.workspaceId, userId);
  requireProjectAccess(
    {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    },
    { id: existing.id, workspaceId: existing.workspaceId },
  );
  requireWorkspaceCapability(membership, "project:update");

  const normalized: {
    name?: string;
    slug?: string;
    description?: string | null;
    timezone?: string;
    retentionDays?: number;
  } = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) {
      throw validationError("Project name must not be empty");
    }
    normalized.name = name;
  }
  if (patch.slug !== undefined) {
    normalized.slug = resolveSlug(patch.name ?? existing.name, patch.slug);
  }
  if (patch.description !== undefined) {
    normalized.description =
      patch.description === null ? null : patch.description.trim() || null;
  }
  if (patch.timezone !== undefined) {
    const tz = patch.timezone.trim();
    if (tz.length === 0) {
      throw validationError("Timezone must not be empty");
    }
    normalized.timezone = tz;
  }
  if (patch.retentionDays !== undefined) {
    if (
      !Number.isInteger(patch.retentionDays) ||
      patch.retentionDays < RETENTION_MIN ||
      patch.retentionDays > RETENTION_MAX
    ) {
      throw validationError(
        `retentionDays must be an integer ${RETENTION_MIN}-365`,
      );
    }
    normalized.retentionDays = patch.retentionDays;
  }

  try {
    const updated = await db.transaction(async (tx: DbTransaction) => {
      const row = await ProjectRepo.updateProjectRow(tx, projectId, normalized);
      if (row === undefined) {
        throw notFound("Project");
      }
      await AuditRepo.insertAuditLog(tx, {
        workspaceId: existing.workspaceId,
        projectId,
        actorUserId: userId,
        action: "project.updated",
        metadataJson: { projectId, patch: normalized },
      });
      return row;
    });
    return toProjectDto(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Project slug already exists in this workspace");
    }
    throw error;
  }
}

/** Transactional idempotent delete: deleting twice returns success. */
export async function deleteProject(
  db: Database,
  userId: string,
  projectId: string,
): Promise<{ deleted: boolean }> {
  const existing = await ProjectRepo.findProjectById(db, projectId);
  if (existing === undefined) {
    return { deleted: false };
  }
  const membership = await MembershipRepo.findMembership(
    db,
    existing.workspaceId,
    userId,
  );
  requireProjectAccess(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
    { id: existing.id, workspaceId: existing.workspaceId },
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
  requireWorkspaceCapability(checked, "project:delete");

  await db.transaction(async (tx: DbTransaction) => {
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: existing.workspaceId,
      projectId: null,
      actorUserId: userId,
      action: "project.deleted",
      metadataJson: {
        projectId: existing.id,
        slug: existing.slug,
        name: existing.name,
      },
    });
    await ProjectRepo.deleteProjectRow(tx, projectId);
  });
  return { deleted: true };
}

export async function createEnvironment(
  db: Database,
  userId: string,
  projectId: string,
  input: { name: string; baseUrl?: string | null; isDefault?: boolean },
): Promise<ReturnType<typeof toEnvironmentDto>> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireWorkspaceCapability(membership, "environment:write");

  const name = input.name.trim();
  if (name.length === 0) {
    throw validationError("Environment name is required");
  }
  let baseUrl: string | null = null;
  if (
    input.baseUrl !== undefined &&
    input.baseUrl !== null &&
    input.baseUrl.trim() !== ""
  ) {
    try {
      baseUrl = parseBaseUrl(input.baseUrl);
    } catch (e) {
      if (e instanceof OriginParseError) {
        throw validationError(e.message);
      }
      throw e;
    }
  }

  try {
    const created = await db.transaction(async (tx: DbTransaction) => {
      if (input.isDefault === true) {
        await EnvironmentRepo.clearDefaultEnvironments(tx, projectId);
      }
      const row = await EnvironmentRepo.insertEnvironment(tx, {
        projectId,
        name,
        baseUrl,
        isDefault: input.isDefault ?? false,
      });
      return row;
    });
    return toEnvironmentDto(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Environment name already exists in this project");
    }
    throw error;
  }
}

export async function listEnvironments(
  db: Database,
  userId: string,
  projectId: string,
): Promise<ReturnType<typeof toEnvironmentDto>[]> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  requireProjectAccess(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
    { id: project.id, workspaceId: project.workspaceId },
  );
  const rows = await EnvironmentRepo.listEnvironmentsByProject(db, projectId);
  return rows.map(toEnvironmentDto);
}

export async function updateEnvironment(
  db: Database,
  userId: string,
  environmentId: string,
  patch: { name?: string; baseUrl?: string | null; isDefault?: boolean },
): Promise<ReturnType<typeof toEnvironmentDto>> {
  const existing = await EnvironmentRepo.findEnvironmentById(db, environmentId);
  if (existing === undefined) {
    throw notFound("Environment");
  }
  const project = await ProjectRepo.findProjectById(db, existing.projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireWorkspaceCapability(membership, "environment:write");

  const normalized: {
    name?: string;
    baseUrl?: string | null;
    isDefault?: boolean;
  } = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) {
      throw validationError("Environment name must not be empty");
    }
    normalized.name = name;
  }
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === null || patch.baseUrl.trim() === "") {
      normalized.baseUrl = null;
    } else {
      try {
        normalized.baseUrl = parseBaseUrl(patch.baseUrl);
      } catch (e) {
        if (e instanceof OriginParseError) {
          throw validationError(e.message);
        }
        throw e;
      }
    }
  }
  if (patch.isDefault !== undefined) {
    normalized.isDefault = patch.isDefault;
  }

  try {
    const updated = await db.transaction(async (tx: DbTransaction) => {
      if (normalized.isDefault === true) {
        await EnvironmentRepo.clearDefaultEnvironments(tx, existing.projectId);
      }
      const row = await EnvironmentRepo.updateEnvironmentRow(
        tx,
        environmentId,
        normalized,
      );
      if (row === undefined) {
        throw notFound("Environment");
      }
      return row;
    });
    return toEnvironmentDto(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("Environment name already exists in this project");
    }
    throw error;
  }
}

export async function deleteEnvironment(
  db: Database,
  userId: string,
  environmentId: string,
): Promise<{ deleted: boolean }> {
  const existing = await EnvironmentRepo.findEnvironmentById(db, environmentId);
  if (existing === undefined) {
    return { deleted: false };
  }
  const project = await ProjectRepo.findProjectById(db, existing.projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireWorkspaceCapability(membership, "environment:write");

  const all = await EnvironmentRepo.listEnvironmentsByProject(
    db,
    existing.projectId,
  );
  if (all.length <= 1) {
    throw validationError("Cannot delete the last environment of a project");
  }
  await db.transaction(async (tx: DbTransaction) => {
    await EnvironmentRepo.deleteEnvironmentRow(tx, environmentId);
    if (existing.isDefault) {
      // Deterministic promotion: smallest name becomes the new default.
      const remaining = (
        await EnvironmentRepo.listEnvironmentsByProject(tx, existing.projectId)
      ).sort((a, b) => a.name.localeCompare(b.name));
      const next = remaining[0];
      if (next !== undefined) {
        await EnvironmentRepo.updateEnvironmentRow(tx, next.id, {
          isDefault: true,
        });
      }
    }
  });
  return { deleted: true };
}

export async function listOriginsForProject(
  db: Database,
  userId: string,
  projectId: string,
): Promise<ReturnType<typeof import("./dto.js").toOriginDto>[]> {
  const { toOriginDto } = await import("./dto.js");
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const membership = await MembershipRepo.findMembership(
    db,
    project.workspaceId,
    userId,
  );
  requireProjectAccess(
    membership === undefined
      ? undefined
      : {
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role as WorkspaceRole,
        },
    { id: project.id, workspaceId: project.workspaceId },
  );
  const rows = await OriginRepo.listOriginsByProject(db, projectId);
  return rows.map(toOriginDto);
}
