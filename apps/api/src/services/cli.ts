import { ProjectRepo, WorkspaceRepo, type Database } from "@replaybug/db";
import { notFound } from "../errors.js";
import type { CliPrincipal } from "../auth/cli-auth.js";

/**
 * RS-03 CLI project info: minimal owning-project envelope for an
 * authenticated project-token principal. Built field-by-field so key
 * material, membership and unrelated projects can never leak through.
 */

export interface CliProjectInfo {
  projectId: string;
  projectName: string;
  projectSlug: string;
  workspaceId: string;
  workspaceName: string;
  timezone: string;
}

export async function getCliProjectInfo(
  db: Database,
  principal: CliPrincipal,
): Promise<CliProjectInfo> {
  const project = await ProjectRepo.findProjectById(db, principal.projectId);
  if (project === undefined) {
    throw notFound("Project");
  }
  const workspace = await WorkspaceRepo.findWorkspaceById(
    db,
    project.workspaceId,
  );
  if (workspace === undefined) {
    throw notFound("Project");
  }
  return {
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    timezone: project.timezone,
  };
}
