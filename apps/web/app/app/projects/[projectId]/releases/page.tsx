"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { projectQuery, releasesQuery } from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { ProjectNav } from "@/components/project/project-nav";
import { RealtimeStatus } from "@/components/realtime-status";
import {
  ReleasesTable,
  type ReleaseListItem,
} from "@/components/releases/releases-table";

function toListItem(value: unknown): ReleaseListItem | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v["id"] !== "string" ||
    typeof v["version"] !== "string" ||
    typeof v["createdAt"] !== "string" ||
    typeof v["artifactCount"] !== "number" ||
    typeof v["sourceMapCount"] !== "number" ||
    typeof v["minifiedAssetCount"] !== "number" ||
    typeof v["occurrenceCount"] !== "number" ||
    typeof v["hasSourceMaps"] !== "boolean"
  ) {
    return null;
  }
  const commitSha = v["commitSha"];
  return {
    id: v["id"],
    version: v["version"],
    commitSha: typeof commitSha === "string" ? commitSha : null,
    createdAt: v["createdAt"],
    artifactCount: v["artifactCount"],
    sourceMapCount: v["sourceMapCount"],
    minifiedAssetCount: v["minifiedAssetCount"],
    occurrenceCount: v["occurrenceCount"],
    hasSourceMaps: v["hasSourceMaps"],
  };
}

/**
 * Releases dashboard: version/commit/created/occurrences plus source-map
 * and artifact counts per release. Metadata only — source-map file contents
 * are never fetched or rendered.
 */
export default function ReleasesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = React.use(params);
  const project = useQuery(projectQuery(projectId));
  const releases = useQuery({
    ...releasesQuery(projectId),
    enabled: project.data !== undefined,
  });

  const breadcrumb = (
    <>
      {project.data !== undefined ? (
        <Crumb href={`/app/workspaces/${project.data.workspaceId}`}>
          Workspace
        </Crumb>
      ) : null}
      <Crumb href={`/app/projects/${projectId}`}>
        {project.data?.name ?? "Project"}
      </Crumb>
      <Crumb current>Releases</Crumb>
    </>
  );

  if (project.isPending) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <RouteSkeleton lines={4} />
      </AppShell>
    );
  }
  if (project.isError || project.data === undefined) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <Alert variant="destructive" title="Project unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const items =
    releases.data === undefined || !Array.isArray(releases.data)
      ? null
      : (releases.data
          .map(toListItem)
          .filter((i) => i !== null) as ReleaseListItem[]);

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Releases</h1>
          <RealtimeStatus projectId={projectId} />
        </div>
        <ProjectNav projectId={projectId} />
        {releases.isPending ? (
          <RouteSkeleton lines={4} />
        ) : releases.isError || items === null ? (
          <Alert variant="destructive" title="Releases unavailable">
            The list could not be loaded. Check your connection and retry.
          </Alert>
        ) : (
          <ReleasesTable projectId={projectId} items={items} />
        )}
      </div>
    </AppShell>
  );
}
