"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  projectQuery,
  environmentsQuery,
  originsQuery,
  keysQuery,
} from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";

/**
 * Project overview: real data only (name/desc/workspace/default env/
 * retention/origins+keys summary + honest telemetry note). No fake
 * counts/charts, no dead buttons.
 */
export default function ProjectOverview({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = React.use(params);
  const project = useQuery(projectQuery(projectId));
  const envs = useQuery(environmentsQuery(projectId));
  const origins = useQuery(originsQuery(projectId));
  const keys = useQuery(keysQuery(projectId));

  if (project.isPending) {
    return (
      <AppShell breadcrumb={<Crumb current>Project</Crumb>}>
        <RouteSkeleton lines={5} />
      </AppShell>
    );
  }
  if (project.isError || project.data === undefined) {
    return (
      <AppShell breadcrumb={<Crumb current>Project</Crumb>}>
        <Alert variant="destructive" title="Project unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const p = project.data;
  const defaultEnv = envs.data?.find((e) => e.isDefault) ?? envs.data?.[0];
  const activeKeys = keys.data?.filter((k) => k.revokedAt == null) ?? [];

  return (
    <AppShell
      breadcrumb={
        <>
          <Crumb href={`/app/workspaces/${p.workspaceId}`}>Workspace</Crumb>
          <Crumb current>{p.name}</Crumb>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{p.name}</h1>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              {p.slug} · <span className="font-mono">{p.id}</span>
            </p>
            {p.description != null && p.description.length > 0 ? (
              <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
                {p.description}
              </p>
            ) : null}
          </div>
          <Link href={`/app/projects/${projectId}/settings`}>
            <Button type="button" variant="outline" size="sm">
              Project settings
            </Button>
          </Link>
        </div>

        <dl className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Default environment
            </dt>
            <dd className="mt-1 text-sm">
              {envs.isPending ? (
                "Loading…"
              ) : defaultEnv !== undefined ? (
                <>
                  <span className="font-medium">{defaultEnv.name}</span>{" "}
                  <Badge>Default</Badge>
                  <br />
                  <span className="font-mono text-xs text-zinc-500">
                    {defaultEnv.baseUrl ?? "no base URL"}
                  </span>
                </>
              ) : (
                "No environments"
              )}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Retention & timezone
            </dt>
            <dd className="mt-1 text-sm">
              {p.retentionDays} days ·{" "}
              <span className="font-mono text-xs">{p.timezone}</span>
            </dd>
            <dd className="mt-1 text-xs text-zinc-500">
              Updated {formatDateTime(p.updatedAt, p.timezone)}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Origins
            </dt>
            <dd className="mt-1 text-sm">
              {origins.isPending
                ? "Loading…"
                : origins.data !== undefined
                  ? origins.data.length === 0
                    ? "None — telemetry is rejected until one is added."
                    : `${origins.data.filter((o) => o.isEnabled).length} enabled / ${origins.data.length} total`
                  : "Unavailable"}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Public keys
            </dt>
            <dd className="mt-1 text-sm">
              {keys.isPending
                ? "Loading…"
                : keys.data !== undefined
                  ? activeKeys.length === 0
                    ? "No active key."
                    : `${activeKeys.length} active (${activeKeys[0]?.prefix ?? ""}…)`
                  : "Unavailable"}
            </dd>
          </div>
        </dl>

        <Alert title="Telemetry not configured yet">
          Event ingest, issues, timelines and reproductions are not part of this
          build. This overview shows configuration only — no event counts or
          charts are faked.
        </Alert>
      </div>
    </AppShell>
  );
}
