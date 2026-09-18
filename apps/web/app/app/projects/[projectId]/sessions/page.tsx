"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  projectQuery,
  sessionsListQuery,
  toSessionsQuery,
  type SessionsParams,
} from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ProjectNav } from "@/components/project/project-nav";
import { RealtimeStatus } from "@/components/realtime-status";
import { formatDateTime } from "@/lib/format";

function readParams(searchParams: URLSearchParams): SessionsParams {
  const get = (key: string): string | undefined => {
    const value = searchParams.get(key);
    return value === null || value === "" ? undefined : value;
  };
  return {
    ...(get("environment") !== undefined
      ? { environment: get("environment") as string }
      : {}),
    ...(get("release") !== undefined
      ? { release: get("release") as string }
      : {}),
    ...(get("hasErrors") === "true" ? { hasErrors: true as const } : {}),
    limit: 25,
  };
}

/**
 * Session list: project telemetry sessions newest-first with explicit
 * Load-more paging (no infinite scroll, no unbounded DOM).
 */
export default function SessionsListPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = React.use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = React.useMemo(
    () => readParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const project = useQuery(projectQuery(projectId));
  const sessions = useInfiniteQuery({
    queryKey: sessionsListQuery(projectId, filters).queryKey,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{projectId}/sessions",
        {
          params: {
            path: { projectId },
            query: {
              ...toSessionsQuery(filters),
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
    enabled: project.data !== undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
  });

  function push(next: Record<string, string | undefined>): void {
    const current = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") {
        current.delete(key);
      } else {
        current.set(key, value);
      }
    }
    const suffix = current.toString();
    router.replace(
      `/app/projects/${projectId}/sessions${suffix === "" ? "" : `?${suffix}`}`,
      { scroll: false },
    );
  }

  const pages = (sessions.data?.pages ?? []) as Array<{
    items: Array<{
      id: string;
      environment: string;
      release: string | null;
      startedAt: string;
      lastSeenAt: string;
      initialUrl: string;
      browserName: string | null;
      osName: string | null;
    }>;
  }>;
  const items = pages.flatMap((p) => p.items);

  return (
    <AppShell
      breadcrumb={
        <>
          {project.data !== undefined ? (
            <Crumb href={`/app/workspaces/${project.data.workspaceId}`}>
              Workspace
            </Crumb>
          ) : null}
          <Crumb href={`/app/projects/${projectId}`}>
            {project.data?.name ?? "Project"}
          </Crumb>
          <Crumb current>Sessions</Crumb>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <RealtimeStatus projectId={projectId} />
        </div>
        <ProjectNav projectId={projectId} />

        <form
          role="search"
          aria-label="Filter sessions"
          className="flex flex-wrap gap-2"
          onSubmit={(e) => e.preventDefault()}
        >
          <div>
            <label htmlFor="session-env" className="sr-only">
              Environment
            </label>
            <input
              id="session-env"
              placeholder="Environment…"
              defaultValue={filters.environment ?? ""}
              key={filters.environment ?? "env"}
              onChange={(e) =>
                push({
                  environment:
                    e.target.value === "" ? undefined : e.target.value,
                })
              }
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label htmlFor="session-release" className="sr-only">
              Release
            </label>
            <input
              id="session-release"
              placeholder="Release…"
              defaultValue={filters.release ?? ""}
              key={filters.release ?? "rel"}
              onChange={(e) =>
                push({
                  release: e.target.value === "" ? undefined : e.target.value,
                })
              }
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={filters.hasErrors === true}
              onChange={(e) =>
                push({ hasErrors: e.target.checked ? "true" : undefined })
              }
            />
            With errors only
          </label>
        </form>

        {sessions.isPending ? (
          <p role="status" className="text-sm text-zinc-500">
            Loading sessions…
          </p>
        ) : sessions.isError ? (
          <Alert variant="destructive" title="Sessions unavailable">
            The list could not be loaded. Check your connection and retry.
          </Alert>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            <p className="font-medium">No sessions yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Sessions appear once the SDK sends telemetry from an allowed
              origin.
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {items.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/app/projects/${projectId}/sessions/${session.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-zinc-800">
                      {session.environment}
                    </span>
                    <span className="min-w-0 flex-1 basis-64 truncate font-mono text-xs">
                      {session.initialUrl}
                    </span>
                    <span className="font-mono text-xs text-zinc-500">
                      {session.browserName ?? "?"} · {session.osName ?? "?"}
                    </span>
                    <span className="font-mono text-xs text-zinc-500">
                      {session.release ?? "unreleased"}
                    </span>
                    <span
                      className="font-mono text-xs text-zinc-500"
                      title={session.lastSeenAt}
                    >
                      {formatDateTime(session.lastSeenAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div>
              {sessions.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sessions.isFetchingNextPage}
                  onClick={() => void sessions.fetchNextPage()}
                >
                  {sessions.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              ) : (
                <span className="text-xs text-zinc-500">End of list</span>
              )}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
