"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createProjectEventStream,
  type EventSourceLike,
  type ProjectUpdate,
  type StreamStatus,
} from "./realtime";
import { getApiBaseUrl } from "./api";
import { queryKeys } from "./queries";

/**
 * Project realtime subscription (Block 6 / T13).
 *
 * Opens one SSE stream per mounted project scope and translates versioned
 * change hints into *targeted* TanStack Query invalidations — exact
 * list/detail keys only, never a global `invalidateQueries()`. SSE is an
 * invalidation signal: every receiver refetches canonical REST state.
 */

function invalidateForUpdate(
  invalidate: (key: readonly unknown[]) => void,
  projectId: string,
  update: ProjectUpdate,
): void {
  const issueKey = queryKeys.issue(update.issueId);
  switch (update.type) {
    case "issue.created":
    case "issue.regressed":
    case "issue.updated":
      invalidate(queryKeys.issues(projectId));
      invalidate(["projects", projectId, "metrics"]);
      invalidate(issueKey);
      break;
    case "comment.created":
      invalidate([...issueKey, "comments"]);
      invalidate([...issueKey, "activity"]);
      invalidate(issueKey);
      break;
    case "assignment.changed":
      invalidate(issueKey);
      invalidate(queryKeys.issues(projectId));
      invalidate([...issueKey, "activity"]);
      break;
    case "tags.changed":
      invalidate(issueKey);
      invalidate(queryKeys.issues(projectId));
      invalidate(queryKeys.tags(projectId));
      break;
  }
}

export function useProjectRealtime(
  projectId: string | undefined,
  options?: {
    /** Test seam + runtime override for the EventSource factory. */
    createEventSource?: (url: string) => EventSourceLike;
  },
): StreamStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<StreamStatus>("connecting");
  const createEventSource = options?.createEventSource;

  React.useEffect(() => {
    if (projectId === undefined || projectId === "") {
      setStatus("closed");
      return;
    }
    const stream = createProjectEventStream({
      baseUrl: getApiBaseUrl(),
      projectId,
      onStatusChange: setStatus,
      onUpdate: (update) => {
        invalidateForUpdate(
          (key) => {
            void queryClient.invalidateQueries({ queryKey: key });
          },
          projectId,
          update,
        );
      },
      ...(createEventSource !== undefined ? { createEventSource } : {}),
    });
    return () => {
      stream.close();
    };
  }, [projectId, queryClient, createEventSource]);

  return status;
}
