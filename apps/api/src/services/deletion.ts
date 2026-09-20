import { parseArtifactStorageKey } from "@replaybug/artifacts";
import {
  deleteProjectRequestSchema,
  deleteWorkspaceRequestSchema,
  type DeleteProjectResponse,
  type DeleteWorkspaceResponse,
  type WorkspaceRole,
} from "@replaybug/contracts";
import {
  ArtifactDeletionRepo,
  AuditRepo,
  MembershipRepo,
  ProjectRepo,
  ReleaseRepo,
  WorkspaceRepo,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import { requireConfirmationError, validationError } from "../errors.js";
import {
  requireWorkspaceCapability,
  requireWorkspaceMembership,
  type MembershipView,
} from "../authz/guards.js";

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

function actorMembershipOrThrow(
  memberships: readonly MembershipRepo.MembershipRow[],
  userId: string,
): MembershipView {
  const membership = memberships.find((item) => item.userId === userId);
  return requireWorkspaceMembership(
    membership === undefined ? undefined : membershipView(membership),
  );
}

function invalidArtifactMetadata(): never {
  throw validationError("Artifact storage metadata is invalid");
}

/**
 * Validate every stored key before the first outbox insert. The release and
 * artifact rows are already locked by the caller, so the key must agree with
 * both relational identity and content hash before it can become a deletion
 * instruction.
 */
function canonicalArtifactKeys(
  artifacts: readonly ReleaseRepo.ReleaseArtifactRow[],
  releasesById: ReadonlyMap<string, ReleaseRepo.ReleaseRow>,
  projectIds: ReadonlySet<string>,
): string[] {
  return artifacts.map((artifact) => {
    let parsed: ReturnType<typeof parseArtifactStorageKey>;
    try {
      parsed = parseArtifactStorageKey(artifact.storageKey);
    } catch {
      return invalidArtifactMetadata();
    }
    const release = releasesById.get(artifact.releaseId);
    if (
      release === undefined ||
      release.id !== parsed.releaseId ||
      release.projectId !== parsed.projectId ||
      !projectIds.has(parsed.projectId) ||
      artifact.contentHash !== parsed.contentHash ||
      artifact.storageKey !==
        `${release.projectId}/${release.id}/${artifact.contentHash}`
    ) {
      return invalidArtifactMetadata();
    }
    return artifact.storageKey;
  });
}

async function enqueueArtifactKeys(
  tx: DbTransaction,
  artifacts: readonly ReleaseRepo.ReleaseArtifactRow[],
  releasesById: ReadonlyMap<string, ReleaseRepo.ReleaseRow>,
  projectIds: ReadonlySet<string>,
): Promise<void> {
  const keys = canonicalArtifactKeys(artifacts, releasesById, projectIds);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const artifact = artifacts[index];
    if (key === undefined || artifact === undefined) {
      invalidArtifactMetadata();
    }
    const release = releasesById.get(artifact.releaseId);
    if (release === undefined) {
      invalidArtifactMetadata();
    }
    await ArtifactDeletionRepo.insertArtifactDeletionOutbox(tx, {
      projectId: release.projectId,
      storageKey: key,
    });
  }
}

function parseProjectDeletionInput(input: unknown): { confirmation: string } {
  const parsed = deleteProjectRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw requireConfirmationError();
  }
  return parsed.data;
}

function parseWorkspaceDeletionInput(input: unknown): { confirmation: string } {
  const parsed = deleteWorkspaceRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw requireConfirmationError();
  }
  return parsed.data;
}

/** Delete a project after authorization, confirmation, and durable enqueue. */
export async function deleteProjectWithArtifacts(
  db: Database,
  actorUserId: string,
  projectId: string,
  input: unknown,
): Promise<DeleteProjectResponse> {
  const request = parseProjectDeletionInput(input);
  return db.transaction(async (tx: DbTransaction) => {
    // Read once to discover the lock order, then re-read under the lock.
    const candidate = await ProjectRepo.findProjectById(tx, projectId);
    if (candidate === undefined) {
      return { deleted: false };
    }
    const workspace = await WorkspaceRepo.lockWorkspaceById(
      tx,
      candidate.workspaceId,
    );
    if (workspace === undefined) {
      return { deleted: false };
    }
    const memberships = await MembershipRepo.lockMembershipsByWorkspace(
      tx,
      workspace.id,
    );
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "project:delete");

    const project = await ProjectRepo.lockProjectById(tx, projectId);
    if (project === undefined || project.workspaceId !== workspace.id) {
      return { deleted: false };
    }
    if (request.confirmation !== project.slug) {
      throw requireConfirmationError();
    }

    const releases = await ReleaseRepo.lockReleasesByProjects(tx, [project.id]);
    const releasesById = new Map(
      releases.map((release) => [release.id, release]),
    );
    const artifacts = await ReleaseRepo.lockArtifactsByReleases(
      tx,
      releases.map((release) => release.id),
    );
    await enqueueArtifactKeys(
      tx,
      artifacts,
      releasesById,
      new Set([project.id]),
    );

    await AuditRepo.insertAuditLog(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      actorUserId,
      action: "project.deletion_requested",
      metadataJson: { projectId: project.id, slug: project.slug },
    });
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      actorUserId,
      action: "project.deletion_completed",
      metadataJson: { projectId: project.id, slug: project.slug },
    });
    await ProjectRepo.deleteProjectRow(tx, project.id);
    return { deleted: true };
  });
}

/** Delete a workspace as its locked owner after durable artifact enqueue. */
export async function deleteWorkspaceWithArtifacts(
  db: Database,
  actorUserId: string,
  workspaceId: string,
  input: unknown,
): Promise<DeleteWorkspaceResponse> {
  const request = parseWorkspaceDeletionInput(input);
  return db.transaction(async (tx: DbTransaction) => {
    const workspace = await WorkspaceRepo.lockWorkspaceById(tx, workspaceId);
    if (workspace === undefined) {
      return { deleted: false };
    }
    const memberships = await MembershipRepo.lockMembershipsByWorkspace(
      tx,
      workspace.id,
    );
    const actor = actorMembershipOrThrow(memberships, actorUserId);
    requireWorkspaceCapability(actor, "workspace:delete");
    if (request.confirmation !== workspace.slug) {
      throw requireConfirmationError();
    }

    const projects = await ProjectRepo.lockProjectsByWorkspace(
      tx,
      workspace.id,
    );
    const projectIds = projects.map((project) => project.id);
    const projectIdSet = new Set(projectIds);
    const releases = await ReleaseRepo.lockReleasesByProjects(tx, projectIds);
    const releasesById = new Map(
      releases.map((release) => [release.id, release]),
    );
    const artifacts = await ReleaseRepo.lockArtifactsByReleases(
      tx,
      releases.map((release) => release.id),
    );
    await enqueueArtifactKeys(tx, artifacts, releasesById, projectIdSet);

    await AuditRepo.insertAuditLog(tx, {
      workspaceId: workspace.id,
      actorUserId,
      action: "workspace.deletion_requested",
      metadataJson: { workspaceId: workspace.id, slug: workspace.slug },
    });
    await AuditRepo.insertAuditLog(tx, {
      workspaceId: workspace.id,
      actorUserId,
      action: "workspace.deletion_completed",
      metadataJson: { workspaceId: workspace.id, slug: workspace.slug },
    });
    await WorkspaceRepo.deleteWorkspaceRow(tx, workspace.id);
    return { deleted: true };
  });
}
