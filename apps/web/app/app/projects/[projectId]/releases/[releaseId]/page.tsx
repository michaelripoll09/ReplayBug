"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { projectQuery, releaseQuery } from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { ProjectNav } from "@/components/project/project-nav";
import { formatDateTime } from "@/lib/format";
import {
  ReleaseArtifactsTable,
  type ReleaseArtifactItem,
} from "@/components/releases/release-artifacts-table";

interface ReleaseDetail {
  id: string;
  version: string;
  commitSha: string | null;
  repositoryUrl: string | null;
  createdAt: string;
  artifactCount: number;
  sourceMapCount: number;
  minifiedAssetCount: number;
  occurrenceCount: number;
  hasSourceMaps: boolean;
  artifacts: ReleaseArtifactItem[];
}

function toArtifact(value: unknown): ReleaseArtifactItem | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v["id"] !== "string" ||
    typeof v["artifactPath"] !== "string" ||
    (v["artifactType"] !== "source_map" &&
      v["artifactType"] !== "minified_asset") ||
    typeof v["contentHash"] !== "string" ||
    typeof v["sizeBytes"] !== "number" ||
    typeof v["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    id: v["id"],
    artifactPath: v["artifactPath"],
    artifactType: v["artifactType"],
    contentHash: v["contentHash"],
    sizeBytes: v["sizeBytes"],
    createdAt: v["createdAt"],
  };
}

function toDetail(value: unknown): ReleaseDetail | null {
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
    typeof v["hasSourceMaps"] !== "boolean" ||
    !Array.isArray(v["artifacts"])
  ) {
    return null;
  }
  const commitSha = v["commitSha"];
  const repositoryUrl = v["repositoryUrl"];
  return {
    id: v["id"],
    version: v["version"],
    commitSha: typeof commitSha === "string" ? commitSha : null,
    repositoryUrl: typeof repositoryUrl === "string" ? repositoryUrl : null,
    createdAt: v["createdAt"],
    artifactCount: v["artifactCount"],
    sourceMapCount: v["sourceMapCount"],
    minifiedAssetCount: v["minifiedAssetCount"],
    occurrenceCount: v["occurrenceCount"],
    hasSourceMaps: v["hasSourceMaps"],
    artifacts: v["artifacts"]
      .map(toArtifact)
      .filter((a) => a !== null) as ReleaseArtifactItem[],
  };
}

/**
 * Release detail: version/commit/repository/created, occurrence and
 * artifact counts, plus the artifact path + status list. Metadata only —
 * source-map file contents are never fetched or rendered.
 */
export default function ReleaseDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; releaseId: string }>;
}): React.JSX.Element {
  const { projectId, releaseId } = React.use(params);
  const project = useQuery(projectQuery(projectId));
  const release = useQuery({
    ...releaseQuery(projectId, releaseId),
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
      <Crumb href={`/app/projects/${projectId}/releases`}>Releases</Crumb>
      <Crumb current>
        {typeof release.data === "object" &&
        release.data !== null &&
        "version" in release.data &&
        typeof release.data.version === "string"
          ? release.data.version
          : "Release"}
      </Crumb>
    </>
  );

  if (project.isPending || release.isPending) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <RouteSkeleton lines={5} />
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

  const detail = release.data === undefined ? null : toDetail(release.data);
  if (release.isError || detail === null) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <Alert variant="destructive" title="Release unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="space-y-4">
        <div>
          <h1 className="break-all font-mono text-xl font-semibold tracking-tight">
            {detail.version}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs text-zinc-500">
            <span>
              commit{" "}
              {detail.commitSha !== null && detail.commitSha !== ""
                ? detail.commitSha
                : "—"}
            </span>
            <span>created {formatDateTime(detail.createdAt)}</span>
            <span>{detail.occurrenceCount} occurrences</span>
            {detail.hasSourceMaps ? (
              <Badge>
                <span className="font-mono text-xs">
                  {detail.sourceMapCount} source maps
                </span>
              </Badge>
            ) : (
              <Badge variant="outline">No source maps</Badge>
            )}
          </p>
          {detail.repositoryUrl !== null ? (
            <p className="mt-1 truncate font-mono text-xs text-zinc-500">
              {detail.repositoryUrl}
            </p>
          ) : null}
        </div>
        <ProjectNav projectId={projectId} />
        <ReleaseArtifactsTable artifacts={detail.artifacts} />
        <p className="text-xs text-zinc-500">
          <Link
            className="underline"
            href={`/app/projects/${projectId}/releases`}
          >
            ← All releases
          </Link>
        </p>
      </div>
    </AppShell>
  );
}
