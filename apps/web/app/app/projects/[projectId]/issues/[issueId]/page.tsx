"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  eventQuery,
  issueOccurrencesQuery,
  issueQuery,
  meQuery,
  projectQuery,
  tagsQuery,
  timelineContextQuery,
  workspaceMembersQuery,
  workspaceQuery,
} from "@/lib/queries";
import {
  canAssignIssue,
  canCommentOnIssue,
  canManageIssueTags,
  canUpdateIssueStatus,
  type WorkspaceRole,
} from "@/lib/rbac";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { ProjectNav } from "@/components/project/project-nav";
import { RealtimeStatus } from "@/components/realtime-status";
import { IssueStatusBadge } from "@/components/issues/issue-status-badge";
import {
  StackView,
  toStackDiagnostic,
  type ExceptionStackValue,
} from "@/components/issues/stack-view";
import {
  AssigneeControl,
  StatusControl,
  TagsManager,
} from "@/components/issues/issue-controls";
import { CommentsSection } from "@/components/issues/comments";
import { ActivityTimeline } from "@/components/issues/activity-timeline";
import { SessionTimeline } from "@/components/sessions/session-timeline";
import { formatDateTime } from "@/lib/format";

function EventEvidence({ eventId }: { eventId: string }) {
  const event = useQuery(eventQuery(eventId));
  if (event.isPending) {
    return (
      <p role="status" className="text-sm text-zinc-500">
        Loading occurrence…
      </p>
    );
  }
  if (event.isError || event.data === undefined) {
    return (
      <Alert variant="destructive" title="Occurrence unavailable">
        It may have expired with retention or you may not have access.
      </Alert>
    );
  }
  const detail = event.data as {
    eventId: string;
    sessionId: string;
    issueId: string | null;
    eventType: string;
    occurredAt: string;
    receivedAt: string;
    environment: string;
    release: string | null;
    pageUrl: string | null;
    processingState: string;
    data: Record<string, unknown>;
    diagnostic?: unknown;
  };
  return (
    <div className="space-y-3">
      <dl className="grid gap-2 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs text-zinc-500">Occurred</dt>
          <dd className="font-mono text-xs">
            {formatDateTime(detail.occurredAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Environment / release</dt>
          <dd className="font-mono text-xs">
            {detail.environment} · {detail.release ?? "unreleased"}
          </dd>
        </div>
        <div className="md:col-span-2">
          <dt className="text-xs text-zinc-500">Page</dt>
          <dd className="truncate font-mono text-xs">
            {detail.pageUrl ?? "—"}
          </dd>
        </div>
      </dl>
      {detail.eventType === "exception" ? (
        <StackView
          values={
            (
              detail.data as unknown as {
                values?: ExceptionStackValue[];
              }
            ).values ?? []
          }
          diagnostic={toStackDiagnostic(detail.diagnostic)}
        />
      ) : (
        <div className="space-y-1">
          <p className="text-xs text-zinc-500">
            {detail.eventType} evidence (safe fields only)
          </p>
          <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
            {JSON.stringify(detail.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Issue detail: header, controls, evidence for the selected occurrence
 * (?event=, shareable), embedded session context and discussion. Stack
 * evidence defaults to the source-mapped view when the worker symbolicated
 * the event, with an explicit Source mapped/Raw toggle and honest
 * unavailable states otherwise. No reproduction or AI UI exists in this
 * build — none is shown.
 */
export default function IssueDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; issueId: string }>;
}) {
  const { projectId, issueId } = React.use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const project = useQuery(projectQuery(projectId));
  const issue = useQuery({
    ...issueQuery(issueId),
    enabled: project.data !== undefined,
  });
  const workspaceId = project.data?.workspaceId;
  const workspace = useQuery({
    ...workspaceQuery(workspaceId ?? "missing"),
    enabled: workspaceId !== undefined,
  });
  const role: WorkspaceRole = workspace.data?.role ?? "viewer";
  const me = useQuery(meQuery());
  const members = useQuery({
    ...workspaceMembersQuery(workspaceId ?? "missing"),
    enabled: workspaceId !== undefined,
  });
  const tags = useQuery({
    ...tagsQuery(projectId),
    enabled: project.data !== undefined,
  });
  const occurrences = useQuery({
    ...issueOccurrencesQuery(issueId, { limit: 50 }),
    enabled: issue.data !== undefined,
  });

  const occurrenceItems = (occurrences.data?.items ?? []) as Array<{
    eventId: string;
    occurredAt: string;
    environment: string;
    release: string | null;
  }>;
  const requestedEvent = searchParams.get("event");
  const selectedEventId =
    requestedEvent !== null &&
    occurrenceItems.some((o) => o.eventId === requestedEvent)
      ? requestedEvent
      : (occurrenceItems[0]?.eventId ?? requestedEvent);
  const context = useQuery({
    ...timelineContextQuery(selectedEventId ?? "missing", {
      before: 20,
      after: 5,
    }),
    enabled: selectedEventId !== null && selectedEventId !== undefined,
  });

  function selectEvent(eventId: string): void {
    const current = new URLSearchParams(searchParams.toString());
    current.set("event", eventId);
    router.replace(
      `/app/projects/${projectId}/issues/${issueId}?${current.toString()}`,
      { scroll: false },
    );
  }

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
      <Crumb href={`/app/projects/${projectId}/issues`}>Issues</Crumb>
      <Crumb current>{issue.data?.title ?? "Issue"}</Crumb>
    </>
  );

  if (project.isPending || issue.isPending) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <RouteSkeleton lines={6} />
      </AppShell>
    );
  }
  if (project.isError || issue.isError || issue.data === undefined) {
    return (
      <AppShell breadcrumb={breadcrumb}>
        <Alert variant="destructive" title="Issue unavailable">
          It may have been deleted, expired, or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const detail = issue.data as {
    id: string;
    type: string;
    title: string;
    normalizedMessage: string;
    status: string;
    severity: string;
    assignee: { id: string; name: string; email: string } | null;
    firstSeenAt: string;
    lastSeenAt: string;
    resolvedAt: string | null;
    firstRelease: string | null;
    lastRelease: string | null;
    occurrenceCount: number;
    affectedSessionCount: number;
    tags: Array<{ id: string; name: string; slug: string }>;
  };
  const memberOptions = (
    (members.data ?? []) as Array<{ id: string; name: string; email: string }>
  ).map((m) => ({ id: m.id, name: m.name, email: m.email }));
  interface ContextEntry {
    id: string;
    sequenceNumber: number;
    eventType: string;
    occurredAt: string;
    environment: string;
    release: string | null;
    pageUrl: string | null;
    summary: string;
  }
  const contextData = context.data as
    | {
        sessionId: string;
        anchor: ContextEntry;
        before: ContextEntry[];
        after: ContextEntry[];
      }
    | undefined;
  const contextEntries: ContextEntry[] =
    contextData === undefined
      ? []
      : [...contextData.before, contextData.anchor, ...contextData.after];

  return (
    <AppShell breadcrumb={breadcrumb}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <IssueStatusBadge status={detail.status} />
              <span className="font-mono text-xs text-zinc-500">
                {detail.type}
              </span>
              <span className="font-mono text-xs text-zinc-500">
                {detail.severity}
              </span>
            </div>
            <h1 className="mt-1 break-words text-xl font-semibold tracking-tight">
              {detail.title}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs text-zinc-500">
              <span>
                {detail.occurrenceCount}× · {detail.affectedSessionCount}{" "}
                sessions
              </span>
              <span>first {formatDateTime(detail.firstSeenAt)}</span>
              <span>last {formatDateTime(detail.lastSeenAt)}</span>
              <RealtimeStatus projectId={projectId} />
            </p>
          </div>
        </div>

        <ProjectNav projectId={projectId} />

        <div className="grid gap-4 md:grid-cols-3">
          <StatusControl
            projectId={projectId}
            issueId={issueId}
            status={detail.status}
            canMutate={canUpdateIssueStatus(role)}
          />
          <AssigneeControl
            projectId={projectId}
            issueId={issueId}
            assigneeId={detail.assignee?.id ?? null}
            members={memberOptions}
            canMutate={canAssignIssue(role)}
          />
          <TagsManager
            projectId={projectId}
            issueId={issueId}
            attached={detail.tags}
            allTags={
              (tags.data ?? []) as Array<{
                id: string;
                name: string;
                slug: string;
              }>
            }
            canMutate={canManageIssueTags(role)}
          />
        </div>
        {role === "viewer" ? (
          <p className="text-xs text-zinc-500">
            You have read-only access — status, assignment, tag and comment
            controls are hidden.
          </p>
        ) : null}

        <section
          aria-labelledby="evidence-heading"
          className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="evidence-heading" className="text-sm font-semibold">
              Occurrence evidence
            </h2>
            {occurrenceItems.length > 1 ? (
              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="occurrence">Occurrence</label>
                <select
                  id="occurrence"
                  value={selectedEventId ?? ""}
                  onChange={(e) => selectEvent(e.target.value)}
                  className="h-8 rounded-md border border-zinc-200 bg-white px-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-950"
                >
                  {occurrenceItems.map((o) => (
                    <option key={o.eventId} value={o.eventId}>
                      {formatDateTime(o.occurredAt)} · {o.environment}
                      {o.release !== null ? ` · ${o.release}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-500">
            {detail.normalizedMessage}
          </p>
          <div className="mt-3">
            {selectedEventId !== null && selectedEventId !== undefined ? (
              <EventEvidence eventId={selectedEventId} />
            ) : (
              <p className="text-sm text-zinc-500">
                No retained occurrences — raw events expired with retention,
                aggregates above remain.
              </p>
            )}
          </div>
        </section>

        <section
          aria-labelledby="context-heading"
          className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="context-heading" className="text-sm font-semibold">
              Session context around this occurrence
            </h2>
            {contextData !== undefined ? (
              <Link
                href={`/app/projects/${projectId}/sessions/${contextData.sessionId}`}
                className="text-xs underline"
              >
                View full session →
              </Link>
            ) : null}
          </div>
          <div className="mt-2">
            {context.isPending ? (
              <p role="status" className="text-sm text-zinc-500">
                Loading context…
              </p>
            ) : context.isError || contextData === undefined ? (
              <p className="text-sm text-zinc-500">
                Context unavailable for this occurrence.
              </p>
            ) : (
              <SessionTimeline
                entries={contextEntries}
                highlightEventId={selectedEventId}
              />
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Showing up to 20 preceding and 5 following events by sequence.
          </p>
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          <CommentsSection
            projectId={projectId}
            issueId={issueId}
            canComment={canCommentOnIssue(role)}
            currentUserId={me.data?.id ?? null}
          />
          <section aria-labelledby="activity-heading" className="space-y-3">
            <h2 id="activity-heading" className="text-sm font-semibold">
              Activity
            </h2>
            <ActivityTimeline
              issueId={issueId}
              members={memberOptions.map((m) => ({ id: m.id, name: m.name }))}
            />
          </section>
        </div>
      </div>
    </AppShell>
  );
}
