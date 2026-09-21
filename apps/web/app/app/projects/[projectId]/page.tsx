"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  projectQuery,
  projectMetricsQuery,
  workspaceQuery,
} from "@/lib/queries";
import type { MetricsRange } from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ProjectNav } from "@/components/project/project-nav";
import { RealtimeStatus } from "@/components/realtime-status";
import {
  MetricsView,
  type MetricsDatum,
} from "@/components/overview/metrics-view";

const RANGES: MetricsRange[] = ["24h", "7d", "30d"];

function parseRange(raw: string | null): MetricsRange {
  return raw === "24h" || raw === "7d" || raw === "30d" ? raw : "7d";
}

/**
 * Project overview: diagnosis-focused metrics with trend and distribution
 * charts, top issues and live invalidation. Range lives in the URL
 * (?range=24h|7d|30d, default 7d) so views are shareable.
 */
export default function ProjectOverview({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = React.use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams.get("range"));

  const project = useQuery(projectQuery(projectId));
  const workspaceId = project.data?.workspaceId;
  const workspace = useQuery({
    ...workspaceQuery(workspaceId ?? "missing"),
    enabled: workspaceId !== undefined,
  });
  const metrics = useQuery({
    ...projectMetricsQuery(projectId, range),
    enabled: project.data !== undefined,
  });

  const breadcrumb = (
    <>
      {project.data !== undefined ? (
        <Crumb href={`/app/workspaces/${project.data.workspaceId}`}>
          Workspace
        </Crumb>
      ) : null}
      <Crumb current>{project.data?.name ?? "Project"}</Crumb>
    </>
  );

  if (project.isPending) {
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

  function setRange(next: MetricsRange): void {
    const current = new URLSearchParams(searchParams.toString());
    current.set("range", next);
    router.replace(`/app/projects/${projectId}?${current.toString()}`, {
      scroll: false,
    });
  }

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {project.data.name}
            </h1>
            <p className="mt-1 flex items-center gap-3 font-mono text-xs text-zinc-500">
              <span>{project.data.slug}</span>
              <RealtimeStatus projectId={projectId} />
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Metrics time range"
              className="flex gap-1"
            >
              {RANGES.map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={r === range ? "default" : "outline"}
                  size="sm"
                  aria-pressed={r === range}
                  onClick={() => setRange(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
            <Link href={`/app/projects/${projectId}/settings`}>
              <Button type="button" variant="outline" size="sm">
                Project settings
              </Button>
            </Link>
          </div>
        </div>

        <ProjectNav projectId={projectId} />

        {metrics.isPending ? (
          <RouteSkeleton lines={6} />
        ) : metrics.isError || metrics.data === undefined ? (
          <Alert variant="destructive" title="Metrics unavailable">
            Aggregates could not be loaded. Issues, sessions and settings below
            still work.
          </Alert>
        ) : (
          <MetricsView
            projectId={projectId}
            metrics={metrics.data as MetricsDatum}
          />
        )}

        <p className="text-xs text-zinc-500">
          Role in workspace:{" "}
          <span className="font-medium">{workspace.data?.role ?? "…"}</span>
          {" · "}
          <Link
            className="underline"
            href={`/app/projects/${projectId}/issues`}
          >
            Browse issues
          </Link>{" "}
          ·{" "}
          <Link
            className="underline"
            href={`/app/projects/${projectId}/sessions`}
          >
            Browse sessions
          </Link>
        </p>
      </div>
    </AppShell>
  );
}
