"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  issuesListQuery,
  projectQuery,
  tagsQuery,
  workspaceMembersQuery,
  type IssuesParams,
} from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ProjectNav } from "@/components/project/project-nav";
import { RealtimeStatus } from "@/components/realtime-status";
import { IssueStatusBadge } from "@/components/issues/issue-status-badge";
import { formatDateTime } from "@/lib/format";

const STATUSES = ["", "open", "investigating", "resolved", "ignored"] as const;
const TYPES = [
  "",
  "exception",
  "unhandled_rejection",
  "console_error",
  "network",
  "message",
] as const;
const SORTS = [
  "last_seen",
  "first_seen",
  "occurrence_count",
  "affected_sessions",
] as const;

function readParams(searchParams: URLSearchParams): IssuesParams {
  const get = (key: string): string | undefined => {
    const value = searchParams.get(key);
    return value === null || value === "" ? undefined : value;
  };
  const status = get("status");
  const type = get("type");
  const sort = get("sort");
  const order = get("order");
  return {
    ...(status === "open" ||
    status === "investigating" ||
    status === "resolved" ||
    status === "ignored"
      ? { status }
      : {}),
    ...(get("environment") !== undefined
      ? { environment: get("environment") as string }
      : {}),
    ...(get("release") !== undefined
      ? { release: get("release") as string }
      : {}),
    ...(type === "exception" ||
    type === "unhandled_rejection" ||
    type === "console_error" ||
    type === "network" ||
    type === "message"
      ? { type }
      : {}),
    ...(get("assigneeId") !== undefined
      ? { assigneeId: get("assigneeId") as string }
      : {}),
    ...(get("unassigned") === "true" ? { unassigned: true as const } : {}),
    ...(get("tag") !== undefined ? { tag: get("tag") as string } : {}),
    ...(get("since") !== undefined ? { since: get("since") as string } : {}),
    ...(get("until") !== undefined ? { until: get("until") as string } : {}),
    ...(get("q") !== undefined ? { q: get("q") as string } : {}),
    ...(sort === "last_seen" ||
    sort === "first_seen" ||
    sort === "occurrence_count" ||
    sort === "affected_sessions"
      ? { sort }
      : {}),
    ...(order === "asc" || order === "desc" ? { order } : {}),
    limit: 25,
    ...(get("cursor") !== undefined ? { cursor: get("cursor") as string } : {}),
  };
}

/**
 * Issue list: every filter, sort order and page cursor lives in the URL,
 * so filtered views are shareable and survive reloads. Free-text search
 * is debounced (~300ms). Empty states distinguish "no issues at all" from
 * "no issues match these filters".
 */
export default function IssuesListPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = React.use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = React.useMemo(() => searchParams.toString(), [searchParams]);
  const filters = React.useMemo(
    () => readParams(new URLSearchParams(query)),
    [query],
  );

  const [draft, setDraft] = React.useState(filters.q ?? "");
  const debounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    setDraft(filters.q ?? "");
  }, [filters.q]);
  React.useEffect(
    () => () => {
      if (debounce.current !== null) {
        clearTimeout(debounce.current);
      }
    },
    [],
  );

  function push(next: Record<string, string | undefined>): void {
    const current = new URLSearchParams(query);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") {
        current.delete(key);
      } else {
        current.set(key, value);
      }
    }
    // Any filter change resets pagination.
    if (!("cursor" in next)) {
      current.delete("cursor");
    }
    const suffix = current.toString();
    router.replace(
      `/app/projects/${projectId}/issues${suffix === "" ? "" : `?${suffix}`}`,
      { scroll: false },
    );
  }

  function onSearch(value: string): void {
    setDraft(value);
    if (debounce.current !== null) {
      clearTimeout(debounce.current);
    }
    debounce.current = setTimeout(() => {
      push({ q: value === "" ? undefined : value });
    }, 300);
  }

  const project = useQuery(projectQuery(projectId));
  const issues = useQuery({
    ...issuesListQuery(projectId, filters),
    enabled: project.data !== undefined,
  });
  const tags = useQuery({
    ...tagsQuery(projectId),
    enabled: project.data !== undefined,
  });
  const workspaceId = project.data?.workspaceId;
  const members = useQuery({
    ...workspaceMembersQuery(workspaceId ?? "missing"),
    enabled: workspaceId !== undefined,
  });

  const hasActiveFilters =
    filters.status !== undefined ||
    filters.environment !== undefined ||
    filters.release !== undefined ||
    filters.type !== undefined ||
    filters.assigneeId !== undefined ||
    filters.unassigned === true ||
    filters.tag !== undefined ||
    filters.since !== undefined ||
    filters.until !== undefined ||
    filters.q !== undefined;

  const items = (issues.data?.items ?? []) as Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    occurrenceCount: number;
    affectedSessionCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastRelease: string | null;
    assignee: { id: string; name: string } | null;
    tags: Array<{ slug: string }>;
  }>;
  const nextCursor = (issues.data as { nextCursor?: string } | undefined)
    ?.nextCursor;

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
          <Crumb current>Issues</Crumb>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Issues</h1>
          <RealtimeStatus projectId={projectId} />
        </div>
        <ProjectNav projectId={projectId} />

        <form
          role="search"
          aria-label="Filter issues"
          className="grid gap-2 md:grid-cols-4"
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="md:col-span-2">
            <label htmlFor="issue-search" className="sr-only">
              Search issues
            </label>
            <input
              id="issue-search"
              type="search"
              value={draft}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search title, message or tag…"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label htmlFor="filter-status" className="sr-only">
              Status
            </label>
            <select
              id="filter-status"
              aria-label="Filter by status"
              value={filters.status ?? ""}
              onChange={(e) =>
                push({
                  status: e.target.value === "" ? undefined : e.target.value,
                })
              }
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "" ? "All statuses" : s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filter-type" className="sr-only">
              Type
            </label>
            <select
              id="filter-type"
              aria-label="Filter by type"
              value={filters.type ?? ""}
              onChange={(e) =>
                push({
                  type: e.target.value === "" ? undefined : e.target.value,
                })
              }
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "" ? "All types" : t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="filter-tag" className="sr-only">
              Tag
            </label>
            <select
              id="filter-tag"
              aria-label="Filter by tag"
              value={filters.tag ?? ""}
              onChange={(e) =>
                push({
                  tag: e.target.value === "" ? undefined : e.target.value,
                })
              }
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="">All tags</option>
              {(tags.data ?? []).map(
                (t: { id: string; name: string; slug: string }) => (
                  <option key={t.id} value={t.slug}>
                    {t.name}
                  </option>
                ),
              )}
            </select>
          </div>
          <div>
            <label htmlFor="filter-assignee" className="sr-only">
              Assignee
            </label>
            <select
              id="filter-assignee"
              aria-label="Filter by assignee"
              value={
                filters.unassigned === true
                  ? "__unassigned"
                  : (filters.assigneeId ?? "")
              }
              onChange={(e) => {
                const value = e.target.value;
                if (value === "__unassigned") {
                  push({ unassigned: "true", assigneeId: undefined });
                } else {
                  push({
                    unassigned: undefined,
                    assigneeId: value === "" ? undefined : value,
                  });
                }
              }}
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <option value="">Anyone</option>
              <option value="__unassigned">Unassigned</option>
              {(members.data ?? []).map((m: { id: string; name: string }) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sort" className="sr-only">
              Sort
            </label>
            <select
              id="sort"
              aria-label="Sort issues"
              value={`${filters.sort ?? "last_seen"}:${filters.order ?? "desc"}`}
              onChange={(e) => {
                const [sort, order] = e.target.value.split(":");
                push({ sort, order });
              }}
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              {SORTS.flatMap((s) =>
                (["desc", "asc"] as const).map((o) => (
                  <option key={`${s}:${o}`} value={`${s}:${o}`}>
                    {s.replace("_", " ")} {o === "desc" ? "↓" : "↑"}
                  </option>
                )),
              )}
            </select>
          </div>
          <div className="flex items-end">
            {hasActiveFilters ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  router.replace(`/app/projects/${projectId}/issues`, {
                    scroll: false,
                  });
                  setDraft("");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>

        {issues.isPending ? (
          <p role="status" className="text-sm text-zinc-500">
            Loading issues…
          </p>
        ) : issues.isError ? (
          <Alert variant="destructive" title="Issues unavailable">
            The list could not be loaded. Check your connection and retry.
          </Alert>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            {hasActiveFilters ? (
              <>
                <p className="font-medium">No issues match these filters</p>
                <p className="mt-1 text-sm text-zinc-500">
                  Try widening the search or clearing a filter.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">No issues yet</p>
                <p className="mt-1 text-sm text-zinc-500">
                  Trigger an error in the demo app — it will appear here without
                  a reload.
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {items.map((issue) => (
                <li key={issue.id}>
                  <Link
                    href={`/app/projects/${projectId}/issues/${issue.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                  >
                    <IssueStatusBadge status={issue.status} />
                    <span className="min-w-0 flex-1 basis-64 truncate text-sm font-medium">
                      {issue.title}
                    </span>
                    <span className="font-mono text-xs text-zinc-500">
                      {issue.type}
                    </span>
                    {issue.tags.map((t) => (
                      <span
                        key={t.slug}
                        className="rounded-full border border-zinc-300 px-1.5 font-mono text-[11px] text-zinc-500 dark:border-zinc-700"
                      >
                        {t.slug}
                      </span>
                    ))}
                    <span className="font-mono text-xs text-zinc-500 tabular-nums">
                      {issue.occurrenceCount}× / {issue.affectedSessionCount}{" "}
                      sessions
                    </span>
                    <span
                      className="font-mono text-xs text-zinc-500"
                      title={issue.lastSeenAt}
                    >
                      {formatDateTime(issue.lastSeenAt)}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {issue.assignee?.name ?? "Unassigned"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3">
              {filters.cursor !== undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => push({ cursor: undefined })}
                >
                  ← First page
                </Button>
              ) : null}
              {nextCursor !== undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => push({ cursor: nextCursor })}
                >
                  Next page →
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
