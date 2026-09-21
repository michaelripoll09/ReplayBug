"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { commentsQuery, useInvalidateDomain } from "@/lib/queries";
import { SafeMarkdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";

export interface CommentItem {
  id: string;
  bodyMarkdown: string;
  author: { id: string; name: string; email: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * Issue comments: oldest-first list, Markdown compose (sanitized render),
 * author-only edit. Hidden compose for viewers; edit buttons only on the
 * viewer's own comments.
 */
export function CommentsSection({
  projectId,
  issueId,
  canComment,
  currentUserId,
}: {
  projectId: string;
  issueId: string;
  canComment: boolean;
  currentUserId: string | null;
}) {
  const invalidate = useInvalidateDomain();
  const comments = useQuery(commentsQuery(issueId, { limit: 50 }));
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editBody, setEditBody] = React.useState("");

  async function refresh(): Promise<void> {
    await invalidate.invalidateIssue(issueId);
    await invalidate.invalidateIssues(projectId);
  }

  const create = useMutation({
    mutationFn: async (text: string) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.POST("/api/v1/issues/{issueId}/comments", {
        params: { path: { issueId } },
        body: { body: text },
      });
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: () => {
      setBody("");
      setError(null);
      void refresh();
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Comment failed");
    },
  });

  const edit = useMutation({
    mutationFn: async (input: { id: string; text: string }) => {
      const {
        data,
        error: err,
        response,
      } = await api.client.PATCH(
        "/api/v1/issues/{issueId}/comments/{commentId}",
        {
          params: { path: { issueId, commentId: input.id } },
          body: { body: input.text },
        },
      );
      if (err !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: err, response });
      }
      return data;
    },
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      void refresh();
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Edit failed");
    },
  });

  const items = (comments.data?.items ?? []) as CommentItem[];

  return (
    <section aria-labelledby="comments-heading" className="space-y-3">
      <h2 id="comments-heading" className="text-sm font-semibold">
        Comments{items.length > 0 ? ` (${items.length})` : ""}
      </h2>
      {comments.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : comments.isError ? (
        <Alert variant="destructive" title="Comments unavailable">
          They may have been deleted or you may not have access.
        </Alert>
      ) : items.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No comments yet. Share findings, hypotheses or fix notes.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((comment) => (
            <li
              key={comment.id}
              className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
            >
              <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {comment.author.name}
                </span>
                <span className="font-mono" title={comment.createdAt}>
                  {formatDateTime(comment.createdAt)}
                  {comment.updatedAt !== comment.createdAt ? " (edited)" : ""}
                </span>
              </div>
              <div className="mt-2">
                {editingId === comment.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editBody.trim() !== "") {
                        edit.mutate({ id: comment.id, text: editBody.trim() });
                      }
                    }}
                    className="space-y-2"
                  >
                    <label htmlFor={`edit-${comment.id}`} className="sr-only">
                      Edit comment
                    </label>
                    <textarea
                      id={`edit-${comment.id}`}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={3}
                      maxLength={10000}
                      className="w-full rounded-md border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
                    />
                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={edit.isPending || editBody.trim() === ""}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <SafeMarkdown source={comment.bodyMarkdown} />
                    {canComment &&
                    currentUserId !== null &&
                    comment.author.id === currentUserId ? (
                      <div className="mt-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label="Edit your comment"
                          onClick={() => {
                            setEditingId(comment.id);
                            setEditBody(comment.bodyMarkdown);
                          }}
                        >
                          Edit
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canComment ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() !== "") {
              create.mutate(body.trim());
            }
          }}
          className="space-y-2"
        >
          <label
            htmlFor="new-comment"
            className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
          >
            Add a comment
          </label>
          <textarea
            id="new-comment"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={10000}
            placeholder="Markdown supported. Findings, hypotheses, fix notes…"
            disabled={create.isPending}
            className="w-full rounded-md border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
          <Button
            type="submit"
            size="sm"
            disabled={create.isPending || body.trim() === ""}
          >
            {create.isPending ? "Posting…" : "Post comment"}
          </Button>
        </form>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Comment failed">
          {error}
        </Alert>
      ) : null}
    </section>
  );
}
