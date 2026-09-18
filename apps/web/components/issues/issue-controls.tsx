"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useInvalidateDomain } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

export type IssueStatusValue =
  "open" | "investigating" | "resolved" | "ignored";

const STATUSES: IssueStatusValue[] = [
  "open",
  "investigating",
  "resolved",
  "ignored",
];

/**
 * Status transition control. Hidden for viewers (read-only): the badge
 * already communicates state. Idempotent server-side; targeted
 * invalidation refreshes detail, list and metrics.
 */
export function StatusControl({
  projectId,
  issueId,
  status,
  canMutate,
}: {
  projectId: string;
  issueId: string;
  status: string;
  canMutate: boolean;
}) {
  const invalidate = useInvalidateDomain();
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (next: IssueStatusValue) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.PATCH("/api/v1/issues/{issueId}/status", {
        params: { path: { issueId } },
        body: { status: next },
      });
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: async () => {
      setError(null);
      await invalidate.invalidateIssue(issueId);
      await invalidate.invalidateIssues(projectId);
      await invalidate.invalidateProjectMetrics(projectId);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Status change failed");
    },
  });

  if (!canMutate) {
    return null;
  }
  return (
    <div className="space-y-1">
      <label
        htmlFor="issue-status"
        className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
      >
        Status
      </label>
      <div className="flex items-center gap-2">
        <select
          id="issue-status"
          aria-label="Change issue status"
          className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          value={
            STATUSES.includes(status as IssueStatusValue) ? status : "open"
          }
          disabled={mutation.isPending}
          onChange={(e) => {
            const next = e.target.value as IssueStatusValue;
            if (next !== status) {
              mutation.mutate(next);
            }
          }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "open"
                ? "Open"
                : s === "investigating"
                  ? "Investigating"
                  : s === "resolved"
                    ? "Resolved"
                    : "Ignored"}
            </option>
          ))}
        </select>
        {mutation.isPending ? (
          <span className="text-xs text-zinc-500" role="status">
            Saving…
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <Alert variant="destructive" title="Status change failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}

export interface MemberOption {
  id: string;
  name: string;
  email: string;
}

/**
 * Assignment control. Assignees must be workspace members (server
 * enforces, 403 otherwise). Hidden for viewers.
 */
export function AssigneeControl({
  projectId,
  issueId,
  assigneeId,
  members,
  canMutate,
}: {
  projectId: string;
  issueId: string;
  assigneeId: string | null;
  members: MemberOption[];
  canMutate: boolean;
}) {
  const invalidate = useInvalidateDomain();
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (userId: string | null) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.PATCH("/api/v1/issues/{issueId}/assignee", {
        params: { path: { issueId } },
        body: { userId },
      });
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: async () => {
      setError(null);
      await invalidate.invalidateIssue(issueId);
      await invalidate.invalidateIssues(projectId);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Assignment failed");
    },
  });

  if (!canMutate) {
    return null;
  }
  return (
    <div className="space-y-1">
      <label
        htmlFor="issue-assignee"
        className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
      >
        Assignee
      </label>
      <div className="flex items-center gap-2">
        <select
          id="issue-assignee"
          aria-label="Assign issue"
          className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          value={assigneeId ?? ""}
          disabled={mutation.isPending}
          onChange={(e) => {
            const next = e.target.value === "" ? null : e.target.value;
            if (next !== assigneeId) {
              mutation.mutate(next);
            }
          }}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.email})
            </option>
          ))}
        </select>
        {mutation.isPending ? (
          <span className="text-xs text-zinc-500" role="status">
            Saving…
          </span>
        ) : null}
      </div>
      {error !== null ? (
        <Alert variant="destructive" title="Assignment failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}

export interface TagOption {
  id: string;
  name: string;
  slug: string;
}

/**
 * Tag manager: attach existing project tags, create-and-attach by name,
 * detach. All idempotent server-side. Hidden for viewers.
 */
export function TagsManager({
  projectId,
  issueId,
  attached,
  allTags,
  canMutate,
}: {
  projectId: string;
  issueId: string;
  attached: TagOption[];
  allTags: TagOption[];
  canMutate: boolean;
}) {
  const invalidate = useInvalidateDomain();
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function refresh(): Promise<void> {
    await invalidate.invalidateIssue(issueId);
    await invalidate.invalidateIssues(projectId);
    await invalidate.invalidateTags(projectId);
  }

  const attach = useMutation({
    mutationFn: async (tagId: string) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.PUT("/api/v1/issues/{issueId}/tags/{tagId}", {
        params: { path: { issueId, tagId } },
      });
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: () => void refresh().then(() => setError(null)),
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Tag update failed");
    },
  });

  const detach = useMutation({
    mutationFn: async (tagId: string) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.DELETE("/api/v1/issues/{issueId}/tags/{tagId}", {
        params: { path: { issueId, tagId } },
      });
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: () => void refresh().then(() => setError(null)),
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Tag update failed");
    },
  });

  const create = useMutation({
    mutationFn: async (tagName: string) => {
      const created = await api.client.POST(
        "/api/v1/projects/{projectId}/tags",
        {
          params: { path: { projectId } },
          body: { name: tagName },
        },
      );
      if (created.error !== undefined || created.data === undefined) {
        throw await api.unwrap({
          data: created.data,
          error: created.error,
          response: created.response,
        });
      }
      const linked = await api.client.PUT(
        "/api/v1/issues/{issueId}/tags/{tagId}",
        { params: { path: { issueId, tagId: created.data.id } } },
      );
      if (linked.error !== undefined || linked.data === undefined) {
        throw await api.unwrap({
          data: linked.data,
          error: linked.error,
          response: linked.response,
        });
      }
      return linked.data;
    },
    onSuccess: () => {
      setName("");
      void refresh().then(() => setError(null));
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Tag creation failed");
    },
  });

  const attachedIds = new Set(attached.map((t) => t.id));
  const available = allTags.filter((t) => !attachedIds.has(t.id));
  const busy = attach.isPending || detach.isPending || create.isPending;

  return (
    <div className="space-y-2">
      <span
        id="issue-tags-label"
        className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
      >
        Tags
      </span>
      {attached.length === 0 ? (
        <p className="text-sm text-zinc-500">No tags attached.</p>
      ) : (
        <ul
          aria-labelledby="issue-tags-label"
          className="flex flex-wrap gap-1.5"
        >
          {attached.map((tag) => (
            <li
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
            >
              <span className="font-mono">{tag.slug}</span>
              {canMutate ? (
                <button
                  type="button"
                  aria-label={`Remove tag ${tag.name}`}
                  disabled={busy}
                  onClick={() => detach.mutate(tag.id)}
                  className="rounded px-1 text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:hover:text-zinc-100"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canMutate ? (
        <div className="flex flex-wrap items-center gap-2">
          {available.length > 0 ? (
            <select
              aria-label="Attach existing tag"
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                if (e.target.value !== "") {
                  attach.mutate(e.target.value);
                  e.target.value = "";
                }
              }}
            >
              <option value="">Attach tag…</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : null}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== "") {
                create.mutate(name.trim());
              }
            }}
          >
            <label htmlFor="new-tag-name" className="sr-only">
              New tag name
            </label>
            <input
              id="new-tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New tag…"
              maxLength={50}
              disabled={busy}
              className="h-9 w-32 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={busy || name.trim() === ""}
            >
              Add
            </Button>
          </form>
        </div>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Tag update failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
