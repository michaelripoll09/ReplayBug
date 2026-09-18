"use client";

import * as React from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  projectQuery,
  sessionEventsQuery,
  sessionQuery,
  toPageQuery,
} from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ProjectNav } from "@/components/project/project-nav";
import { SessionTimeline } from "@/components/sessions/session-timeline";
import { formatDateTime } from "@/lib/format";

/**
 * Session detail: metadata plus the full chronological timeline with
 * explicit Load-more paging (bounded requests, user-driven DOM growth).
 */
export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = React.use(params);
  const project = useQuery(projectQuery(projectId));
  const session = useQuery({
    ...sessionQuery(sessionId),
    enabled: project.data !== undefined,
  });
  const events = useInfiniteQuery({
    queryKey: sessionEventsQuery(sessionId, { limit: 100 }).queryKey,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/sessions/{sessionId}/events",
        {
          params: {
            path: { sessionId },
            query: {
              ...toPageQuery({ limit: 100 }),
              ...(pageParam !== undefined ? { cursor: pageParam } : {}),
            },
          },
        },
      );
      if (error !== undefined || data === undefined) {
        throw await api.unwrap({ data, error, response });
      }
      return data;
    },
    enabled: session.data !== undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
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
      <Crumb href={`/app/projects/${projectId}/sessions`}>Sessions</Crumb>
      <Crumb current>Session</Crumb>
    </>
  );

  if (project.isPending || session.isPending) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <RouteSkeleton lines={6} />
      </AppShell>
    );
  }
  if (project.isError || session.isError || session.data === undefined) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <Alert variant="destructive" title="Session unavailable">
          It may have expired with retention or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const detail = session.data as {
    id: string;
    environment: string;
    release: string | null;
    startedAt: string;
    lastSeenAt: string;
    initialUrl: string;
    browserName: string | null;
    browserVersion: string | null;
    osName: string | null;
    osVersion: string | null;
    deviceType: string | null;
    sdkVersion: string;
  };
  const pages = (events.data?.pages ?? []) as Array<{
    items: Array<{
      id: string;
      sequenceNumber: number;
      eventType: string;
      occurredAt: string;
      environment: string;
      release: string | null;
      pageUrl: string | null;
      summary: string;
    }>;
  }>;
  const entries = pages.flatMap((p) => p.items);

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="space-y-6">
        <div>
          <h1 className="break-words font-mono text-lg font-semibold tracking-tight">
            Session
          </h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">{detail.id}</p>
        </div>
        <ProjectNav projectId={projectId} />

        <dl className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500">Environment / release</dt>
            <dd className="font-mono text-xs">
              {detail.environment} · {detail.release ?? "unreleased"}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500">Browser / OS</dt>
            <dd className="font-mono text-xs">
              {detail.browserName ?? "?"} {detail.browserVersion ?? ""} ·{" "}
              {detail.osName ?? "?"} {detail.osVersion ?? ""} ·{" "}
              {detail.deviceType ?? "?"}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500">Window</dt>
            <dd className="font-mono text-xs">
              {formatDateTime(detail.startedAt)} →{" "}
              {formatDateTime(detail.lastSeenAt)}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3 md:col-span-3 dark:border-zinc-800">
            <dt className="text-xs text-zinc-500">Entry URL</dt>
            <dd className="break-all font-mono text-xs">{detail.initialUrl}</dd>
          </div>
        </dl>

        <section aria-labelledby="timeline-heading" className="space-y-3">
          <h2 id="timeline-heading" className="text-sm font-semibold">
            Timeline ({entries.length} event{entries.length === 1 ? "" : "s"}{" "}
            loaded)
          </h2>
          {events.isPending ? (
            <p role="status" className="text-sm text-zinc-500">
              Loading timeline…
            </p>
          ) : events.isError ? (
            <Alert variant="destructive" title="Timeline unavailable">
              Events could not be loaded.
            </Alert>
          ) : (
            <>
              <SessionTimeline entries={entries} linkIssues={false} />
              <div>
                {events.hasNextPage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={events.isFetchingNextPage}
                    onClick={() => void events.fetchNextPage()}
                  >
                    {events.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                ) : (
                  <span className="text-xs text-zinc-500">End of timeline</span>
                )}
              </div>
            </>
          )}
        </section>

        <p className="text-xs text-zinc-500">
          <Link
            className="underline"
            href={`/app/projects/${projectId}/sessions`}
          >
            ← All sessions
          </Link>
        </p>
      </div>
    </AppShell>
  );
}
