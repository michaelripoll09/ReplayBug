"use client";

import { useQuery } from "@tanstack/react-query";
import { activityQuery } from "@/lib/queries";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";

export interface ActivityMember {
  id: string;
  name: string;
}

function describeActivity(
  type: string,
  actorName: string,
  metadata: Record<string, unknown>,
  members: ActivityMember[],
): string {
  const nameOf = (id: unknown): string =>
    typeof id === "string"
      ? (members.find((m) => m.id === id)?.name ?? `user ${id.slice(0, 8)}`)
      : "someone";
  switch (type) {
    case "created":
      return "Issue created";
    case "status_changed": {
      const from =
        typeof metadata["from"] === "string" ? metadata["from"] : "?";
      const to = typeof metadata["to"] === "string" ? metadata["to"] : "?";
      return `${actorName} changed status ${from} → ${to}`;
    }
    case "assigned":
      return `${actorName} assigned to ${nameOf(metadata["userId"])}`;
    case "unassigned":
      return `${actorName} unassigned the issue`;
    case "comment_added":
      return `${actorName} commented`;
    case "regression_detected":
      return "Regression detected — issue reopened";
    case "reproduction_generated":
      return `${actorName} generated a reproduction test`;
    case "ai_analysis_requested":
      return `${actorName} requested AI analysis`;
    case "ai_analysis_completed":
      return "AI analysis completed";
    case "ai_analysis_failed":
      return "AI analysis failed";
    default:
      return type;
  }
}

/**
 * Append-only issue activity timeline, newest first. Metadata stays
 * minimal ({from,to}, {userId}, {commentId}) — bodies never appear here.
 */
export function ActivityTimeline({
  issueId,
  members,
}: {
  issueId: string;
  members: ActivityMember[];
}) {
  const activity = useQuery(activityQuery(issueId, { limit: 50 }));

  if (activity.isPending) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (activity.isError) {
    return (
      <Alert variant="destructive" title="Activity unavailable">
        It may have been deleted or you may not have access.
      </Alert>
    );
  }
  const items = activity.data?.items ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-zinc-500">No activity yet.</p>;
  }
  return (
    <ol className="space-y-2">
      {items.map(
        (item: {
          id: string;
          type: string;
          actor: { id: string; name: string } | null;
          metadata: Record<string, unknown>;
          createdAt: string;
        }) => (
          <li
            key={item.id}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span>
              {describeActivity(
                item.type,
                item.actor?.name ?? "System",
                item.metadata,
                members,
              )}
            </span>
            <span
              className="shrink-0 font-mono text-xs text-zinc-500"
              title={item.createdAt}
            >
              {formatDateTime(item.createdAt)}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}
