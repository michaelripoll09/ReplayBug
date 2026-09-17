import type {
  Project,
  ProjectEnvironment,
  ProjectKeyMeta,
  ProjectOrigin,
  Workspace,
  WorkspaceWithRole,
  WorkspaceRole,
} from "@replaybug/contracts";
import type {
  AuditRepo,
  EnvironmentRepo,
  MembershipRepo,
  OriginRepo,
  ProjectKeyRepo,
  ProjectRepo,
  WorkspaceRepo,
} from "@replaybug/db";

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toWorkspaceDto(row: WorkspaceRepo.WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toWorkspaceWithRoleDto(
  row: WorkspaceRepo.WorkspaceRow,
  role: WorkspaceRole,
): WorkspaceWithRole {
  return { ...toWorkspaceDto(row), role };
}

export function toProjectDto(row: ProjectRepo.ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    timezone: row.timezone,
    retentionDays: row.retentionDays,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toEnvironmentDto(
  row: EnvironmentRepo.EnvironmentRow,
): ProjectEnvironment {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    baseUrl: row.baseUrl,
    isDefault: row.isDefault,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toOriginDto(row: OriginRepo.OriginRow): ProjectOrigin {
  return {
    id: row.id,
    projectId: row.projectId,
    origin: row.origin,
    isEnabled: row.isEnabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toKeyMetaDto(
  row: ProjectKeyRepo.ProjectKeyRow,
): ProjectKeyMeta {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind === "secret" ? "secret" : "public_ingest",
    name: row.name,
    prefix: row.prefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
  };
}

export type MembershipRow = MembershipRepo.MembershipRow;
export type AuditRow = AuditRepo.AuditRow;
