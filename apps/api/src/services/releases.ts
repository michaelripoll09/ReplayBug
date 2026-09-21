import {
  ReleaseRepo,
  ReleaseValidationError,
  type Database,
} from "@replaybug/db";
import { releaseVersionConflict, validationError } from "../errors.js";
import type { CliPrincipal } from "../auth/cli-auth.js";

/**
 * RS-04 CLI releases: project-scoped create/list for secret-token callers.
 *
 * Create is idempotent per (project, version): identical metadata returns
 * the existing row with `created: false` (HTTP 200); any difference in the
 * immutable identity metadata (`commit_sha`, `repository_url`) is a 409
 * `RELEASE_VERSION_CONFLICT` with the stored row left untouched. Envelopes
 * are field-built so key material can never leak; the list view additionally
 * omits `repository_url`/`storage_key` internals and carries artifact counts
 * for the RS-07 CLI and the RS-10 dashboard contract.
 */

export interface CliReleaseDto {
  id: string;
  version: string;
  /** Stored commit SHA (request field is `commitSha`). */
  commit: string | null;
  repositoryUrl: string | null;
  createdAt: string;
}

export interface CliReleaseListItem {
  version: string;
  commit: string | null;
  artifactCount: number;
  createdAt: string;
}

export interface CreateCliReleaseResult {
  release: CliReleaseDto;
  created: boolean;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toReleaseDto(row: ReleaseRepo.ReleaseRow): CliReleaseDto {
  return {
    id: row.id,
    version: row.version,
    commit: row.commitSha,
    repositoryUrl: row.repositoryUrl,
    createdAt: iso(row.createdAt),
  };
}

function validationMessage(error: ReleaseValidationError): string {
  return error.message;
}

export async function createCliRelease(
  db: Database,
  principal: CliPrincipal,
  input: { version?: unknown; commitSha?: unknown; repositoryUrl?: unknown },
): Promise<CreateCliReleaseResult> {
  let created: ReleaseRepo.CreateReleaseResult;
  try {
    created = await ReleaseRepo.createRelease(db, {
      projectId: principal.projectId,
      version: input.version,
      commitSha: input.commitSha,
      repositoryUrl: input.repositoryUrl,
    });
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw validationError(validationMessage(error));
    }
    if (error instanceof ReleaseRepo.ReleaseVersionConflictError) {
      throw releaseVersionConflict();
    }
    throw error;
  }
  return { release: toReleaseDto(created.row), created: created.created };
}

export async function listCliReleases(
  db: Database,
  principal: CliPrincipal,
): Promise<CliReleaseListItem[]> {
  const rows = await ReleaseRepo.listReleasesByProject(db, principal.projectId);
  const counts = await ReleaseRepo.countArtifactsByReleaseIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    version: row.version,
    commit: row.commitSha,
    artifactCount: counts.get(row.id) ?? 0,
    createdAt: iso(row.createdAt),
  }));
}
