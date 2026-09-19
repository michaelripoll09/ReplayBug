import {
  MembershipRepo,
  ProjectRepo,
  ReleaseRepo,
  type Database,
} from "@replaybug/db";
import type { WorkspaceRole } from "@replaybug/contracts";
import { notFound } from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";

/**
 * RS-10 session-authenticated release reads for the dashboard.
 *
 * Auth: dashboard session user + the existing project-membership check
 * (workspace membership scoped to the release's project). Every project
 * member may read — the gate is `project:read` (viewer and up), never the
 * CLI secret-token capability. Cross-workspace projects read as NOT_FOUND.
 *
 * DTOs are built field-by-field: `storage_key` and content hashes at the
 * release level never leave the server. The detail view exposes per-artifact
 * metadata (path/type/hash/size) but never storage keys or file bytes.
 */

export type DashboardArtifactType = "source_map" | "minified_asset";

export interface DashboardReleaseArtifactDto {
  id: string;
  artifactPath: string;
  artifactType: DashboardArtifactType;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DashboardReleaseDto {
  id: string;
  version: string;
  commitSha: string | null;
  repositoryUrl: string | null;
  createdAt: string;
  artifactCount: number;
  sourceMapCount: number;
  minifiedAssetCount: number;
  occurrenceCount: number;
  /** Artifact status summary: true once at least one source map is stored. */
  hasSourceMaps: boolean;
}

export interface DashboardReleaseDetailDto extends DashboardReleaseDto {
  artifacts: DashboardReleaseArtifactDto[];
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function authorizeReleaseRead(
  db: Database,
  userId: string,
  projectId: string,
): Promise<{ projectId: string }> {
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
  requireWorkspaceCapability(checked, "project:read");
  return { projectId: project.id };
}

function toArtifactDto(
  row: ReleaseRepo.ReleaseArtifactRow,
): DashboardReleaseArtifactDto {
  return {
    id: row.id,
    artifactPath: row.artifactPath,
    artifactType:
      row.artifactType === "source_map" ? "source_map" : "minified_asset",
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes,
    createdAt: iso(row.createdAt),
  };
}

export async function listDashboardReleases(
  db: Database,
  userId: string,
  projectId: string,
): Promise<DashboardReleaseDto[]> {
  const authorized = await authorizeReleaseRead(db, userId, projectId);
  const rows = await ReleaseRepo.listReleasesByProject(
    db,
    authorized.projectId,
  );
  const [typeCounts, occurrenceCounts] = await Promise.all([
    ReleaseRepo.countArtifactsByReleaseIdsByType(
      db,
      rows.map((row) => row.id),
    ),
    ReleaseRepo.countEventsByProjectAndReleaseVersions(
      db,
      authorized.projectId,
      rows.map((row) => row.version),
    ),
  ]);
  return rows.map((row) => {
    const counts = typeCounts.get(row.id) ?? {
      total: 0,
      sourceMap: 0,
      minifiedAsset: 0,
    };
    return {
      id: row.id,
      version: row.version,
      commitSha: row.commitSha,
      repositoryUrl: row.repositoryUrl,
      createdAt: iso(row.createdAt),
      artifactCount: counts.total,
      sourceMapCount: counts.sourceMap,
      minifiedAssetCount: counts.minifiedAsset,
      occurrenceCount: occurrenceCounts.get(row.version) ?? 0,
      hasSourceMaps: counts.sourceMap > 0,
    };
  });
}

export async function getDashboardRelease(
  db: Database,
  userId: string,
  projectId: string,
  releaseId: string,
): Promise<DashboardReleaseDetailDto> {
  const authorized = await authorizeReleaseRead(db, userId, projectId);
  const row = await ReleaseRepo.findReleaseByIdInProject(
    db,
    authorized.projectId,
    releaseId,
  );
  if (row === undefined) {
    throw notFound("Release");
  }
  const [artifacts, typeCounts, occurrenceCounts] = await Promise.all([
    ReleaseRepo.listArtifactsByRelease(db, row.id),
    ReleaseRepo.countArtifactsByReleaseIdsByType(db, [row.id]),
    ReleaseRepo.countEventsByProjectAndReleaseVersions(
      db,
      authorized.projectId,
      [row.version],
    ),
  ]);
  const counts = typeCounts.get(row.id) ?? {
    total: 0,
    sourceMap: 0,
    minifiedAsset: 0,
  };
  return {
    id: row.id,
    version: row.version,
    commitSha: row.commitSha,
    repositoryUrl: row.repositoryUrl,
    createdAt: iso(row.createdAt),
    artifactCount: counts.total,
    sourceMapCount: counts.sourceMap,
    minifiedAssetCount: counts.minifiedAsset,
    occurrenceCount: occurrenceCounts.get(row.version) ?? 0,
    hasSourceMaps: counts.sourceMap > 0,
    artifacts: artifacts.map(toArtifactDto),
  };
}
