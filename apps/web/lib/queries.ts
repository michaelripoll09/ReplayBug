"use client";

import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * TanStack Query factories. Targeted invalidation only: callers invalidate
 * the exact list/detail key they mutated. No global `invalidateQueries()`
 * without a key, no polling, no optimistic key rotation.
 *
 * Query keys are stable tuples so server-prefetched state and client
 * refetches share identity.
 */

export const queryKeys = {
  me: ["me"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspaces", id] as const,
  projects: (workspaceId: string) =>
    ["workspaces", workspaceId, "projects"] as const,
  project: (id: string) => ["projects", id] as const,
  environments: (projectId: string) =>
    ["projects", projectId, "environments"] as const,
  origins: (projectId: string) => ["projects", projectId, "origins"] as const,
  keys: (projectId: string) => ["projects", projectId, "keys"] as const,
  // RS-10 releases + secret tokens. Same targeted-invalidation contract as
  // every other factory: exact list/detail keys only, never the whole cache.
  // Secret-token plaintext is never stored here — creation responses stay in
  // component memory (see SecretTokensSettings) and list payloads are
  // metadata only.
  releases: (projectId: string) => ["projects", projectId, "releases"] as const,
  release: (projectId: string, releaseId: string) =>
    ["projects", projectId, "releases", releaseId] as const,
  secretTokens: (projectId: string) =>
    ["projects", projectId, "secret-tokens"] as const,
  // Block 6 dashboard. List keys carry serialized params so parallel
  // filter states cache independently; invalidating a prefix refreshes
  // every param variant of that scope — never the whole cache.
  projectMetrics: (projectId: string, range: string) =>
    ["projects", projectId, "metrics", range] as const,
  issues: (projectId: string) => ["projects", projectId, "issues"] as const,
  issuesList: (projectId: string, params: IssuesParams) =>
    ["projects", projectId, "issues", "list", serializeParams(params)] as const,
  issue: (issueId: string) => ["issues", issueId] as const,
  issueOccurrences: (issueId: string, params: PageParams) =>
    ["issues", issueId, "occurrences", serializeParams(params)] as const,
  event: (eventId: string) => ["events", eventId] as const,
  sessions: (projectId: string) => ["projects", projectId, "sessions"] as const,
  sessionsList: (projectId: string, params: SessionsParams) =>
    [
      "projects",
      projectId,
      "sessions",
      "list",
      serializeParams(params),
    ] as const,
  session: (sessionId: string) => ["sessions", sessionId] as const,
  sessionEvents: (sessionId: string, params: PageParams) =>
    ["sessions", sessionId, "events", serializeParams(params)] as const,
  timelineContext: (eventId: string, params: TimelineParams) =>
    ["events", eventId, "timeline-context", serializeParams(params)] as const,
  comments: (issueId: string, params: PageParams) =>
    ["issues", issueId, "comments", serializeParams(params)] as const,
  activity: (issueId: string, params: PageParams) =>
    ["issues", issueId, "activity", serializeParams(params)] as const,
  // Playwright reproductions. List summaries stay small (no code); the
  // detail key carries one generation record including its code.
  issueReproductions: (issueId: string, params: PageParams) =>
    ["issues", issueId, "reproductions", serializeParams(params)] as const,
  reproduction: (reproductionId: string) =>
    ["reproductions", reproductionId] as const,
  tags: (projectId: string) => ["projects", projectId, "tags"] as const,
  workspaceMembers: (workspaceId: string) =>
    ["workspaces", workspaceId, "members"] as const,
  notifications: (params: NotificationsParams) =>
    ["notifications", serializeParams(params)] as const,
  unreadCount: ["notifications", "unread-count"] as const,
};

/** Stable string serialization for param-bearing query keys. */
export function serializeParams(params: object): string {
  const entries = Object.entries(params as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join("&");
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}

export interface IssuesParams extends PageParams {
  status?: "open" | "investigating" | "resolved" | "ignored";
  environment?: string;
  release?: string;
  type?:
    | "exception"
    | "unhandled_rejection"
    | "console_error"
    | "network"
    | "message";
  assigneeId?: string;
  unassigned?: boolean;
  tag?: string;
  since?: string;
  until?: string;
  q?: string;
  sort?: "last_seen" | "first_seen" | "occurrence_count" | "affected_sessions";
  order?: "asc" | "desc";
}

export interface SessionsParams extends PageParams {
  environment?: string;
  release?: string;
  since?: string;
  until?: string;
  hasErrors?: boolean;
  order?: "asc" | "desc";
}

export interface TimelineParams {
  before?: number;
  after?: number;
}

export interface NotificationsParams extends PageParams {
  unreadOnly?: boolean;
}

export function toIssuesQuery(params: IssuesParams): Record<string, string> {
  return {
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.environment !== undefined
      ? { environment: params.environment }
      : {}),
    ...(params.release !== undefined ? { release: params.release } : {}),
    ...(params.type !== undefined ? { type: params.type } : {}),
    ...(params.assigneeId !== undefined
      ? { assigneeId: params.assigneeId }
      : {}),
    ...(params.unassigned === true ? { unassigned: "true" } : {}),
    ...(params.tag !== undefined ? { tag: params.tag } : {}),
    ...(params.since !== undefined ? { since: params.since } : {}),
    ...(params.until !== undefined ? { until: params.until } : {}),
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
    ...(params.order !== undefined ? { order: params.order } : {}),
    ...(params.limit !== undefined ? { limit: String(params.limit) } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
}

export function toPageQuery(params: PageParams): Record<string, string> {
  return {
    ...(params.limit !== undefined ? { limit: String(params.limit) } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
}

async function fetchGet<T>(
  run: () => Promise<{
    data?: T | undefined;
    error?: unknown;
    response: Response;
  }>,
): Promise<T> {
  const { data, error, response } = await run();
  if (error !== undefined || data === undefined) {
    return api.unwrap({ data: data as T | undefined, error, response });
  }
  return data as T;
}

export type MetricsRange = "24h" | "7d" | "30d";

export function projectMetricsQuery(projectId: string, range: MetricsRange) {
  return queryOptions({
    queryKey: queryKeys.projectMetrics(projectId, range),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/metrics", {
          params: { path: { projectId }, query: { range } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function issuesListQuery(projectId: string, params: IssuesParams) {
  return queryOptions({
    queryKey: queryKeys.issuesList(projectId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/issues", {
          params: { path: { projectId }, query: toIssuesQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function issueQuery(issueId: string) {
  return queryOptions({
    queryKey: queryKeys.issue(issueId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/issues/{issueId}", {
          params: { path: { issueId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function issueOccurrencesQuery(issueId: string, params: PageParams) {
  return queryOptions({
    queryKey: queryKeys.issueOccurrences(issueId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/issues/{issueId}/occurrences", {
          params: { path: { issueId }, query: toPageQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function eventQuery(eventId: string) {
  return queryOptions({
    queryKey: queryKeys.event(eventId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/events/{eventId}", {
          params: { path: { eventId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function toSessionsQuery(
  params: SessionsParams,
): Record<string, string> {
  return {
    ...(params.environment !== undefined
      ? { environment: params.environment }
      : {}),
    ...(params.release !== undefined ? { release: params.release } : {}),
    ...(params.since !== undefined ? { since: params.since } : {}),
    ...(params.until !== undefined ? { until: params.until } : {}),
    ...(params.hasErrors === true ? { hasErrors: "true" } : {}),
    ...(params.order !== undefined ? { order: params.order } : {}),
    ...(params.limit !== undefined ? { limit: String(params.limit) } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  };
}

export function sessionsListQuery(projectId: string, params: SessionsParams) {
  return queryOptions({
    queryKey: queryKeys.sessionsList(projectId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/sessions", {
          params: { path: { projectId }, query: toSessionsQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function sessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: queryKeys.session(sessionId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/sessions/{sessionId}", {
          params: { path: { sessionId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function sessionEventsQuery(sessionId: string, params: PageParams) {
  return queryOptions({
    queryKey: queryKeys.sessionEvents(sessionId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/sessions/{sessionId}/events", {
          params: { path: { sessionId }, query: toPageQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function timelineContextQuery(eventId: string, params: TimelineParams) {
  return queryOptions({
    queryKey: queryKeys.timelineContext(eventId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/events/{eventId}/timeline-context", {
          params: {
            path: { eventId },
            query: {
              ...(params.before !== undefined
                ? { before: String(params.before) }
                : {}),
              ...(params.after !== undefined
                ? { after: String(params.after) }
                : {}),
            },
          },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function commentsQuery(issueId: string, params: PageParams) {
  return queryOptions({
    queryKey: queryKeys.comments(issueId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/issues/{issueId}/comments", {
          params: { path: { issueId }, query: toPageQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function activityQuery(issueId: string, params: PageParams) {
  return queryOptions({
    queryKey: queryKeys.activity(issueId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/issues/{issueId}/activity", {
          params: { path: { issueId }, query: toPageQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function issueReproductionsQuery(issueId: string, params: PageParams) {
  return queryOptions({
    queryKey: queryKeys.issueReproductions(issueId, params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/issues/{issueId}/reproductions", {
          params: { path: { issueId }, query: toPageQuery(params) },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function reproductionQuery(reproductionId: string) {
  return queryOptions({
    queryKey: queryKeys.reproduction(reproductionId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/reproductions/{reproductionId}", {
          params: { path: { reproductionId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function tagsQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.tags(projectId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/tags", {
          params: { path: { projectId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function workspaceMembersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.workspaceMembers(workspaceId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/workspaces/{id}/members", {
          params: { path: { id: workspaceId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function notificationsQuery(params: NotificationsParams) {
  return queryOptions({
    queryKey: queryKeys.notifications(params),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/notifications", {
          params: {
            query: {
              ...(params.unreadOnly === true ? { unreadOnly: "true" } : {}),
              ...(params.limit !== undefined
                ? { limit: String(params.limit) }
                : {}),
              ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
            },
          },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function unreadCountQuery() {
  return queryOptions({
    queryKey: queryKeys.unreadCount,
    queryFn: () =>
      fetchGet(() => api.client.GET("/api/v1/notifications/unread-count", {})),
    staleTime: 30_000,
    retry: false,
  });
}

export function meQuery() {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const { data, error, response } = await api.client.GET("/api/v1/me", {});
      if (error !== undefined) {
        throw await api
          .unwrap({ data, error, response })
          .catch((e: unknown) => {
            throw e;
          });
      }
      if (data === undefined) {
        throw new Error("Empty response");
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function workspacesQuery() {
  return queryOptions({
    queryKey: queryKeys.workspaces,
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/workspaces",
        {},
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function workspaceQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.workspace(id),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/workspaces/{id}",
        { params: { path: { id } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function projectsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.projects(workspaceId),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/workspaces/{workspaceId}/projects",
        { params: { path: { workspaceId } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function projectQuery(id: string) {
  return queryOptions({
    queryKey: queryKeys.project(id),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{id}",
        { params: { path: { id } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function environmentsQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.environments(projectId),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{projectId}/environments",
        { params: { path: { projectId } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function originsQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.origins(projectId),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{projectId}/origins",
        { params: { path: { projectId } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function keysQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.keys(projectId),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{projectId}/keys",
        { params: { path: { projectId } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function releasesQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.releases(projectId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/releases", {
          params: { path: { projectId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function releaseQuery(projectId: string, releaseId: string) {
  return queryOptions({
    queryKey: queryKeys.release(projectId, releaseId),
    queryFn: () =>
      fetchGet(() =>
        api.client.GET("/api/v1/projects/{projectId}/releases/{releaseId}", {
          params: { path: { projectId, releaseId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

export function secretTokensQuery(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.secretTokens(projectId),
    queryFn: async () => {
      const { data, error, response } = await api.client.GET(
        "/api/v1/projects/{projectId}/secret-tokens",
        { params: { path: { projectId } } },
      );
      if (error !== undefined || data === undefined) {
        return api.unwrap({ data, error, response });
      }
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

/** Invalidate exactly one domain list/detail after a mutation. */
export function useInvalidateDomain(): {
  invalidateWorkspaces: () => Promise<void>;
  invalidateWorkspace: (id: string) => Promise<void>;
  invalidateProjects: (workspaceId: string) => Promise<void>;
  invalidateProject: (id: string) => Promise<void>;
  invalidateEnvironments: (projectId: string) => Promise<void>;
  invalidateOrigins: (projectId: string) => Promise<void>;
  invalidateKeys: (projectId: string) => Promise<void>;
  invalidateReleases: (projectId: string) => Promise<void>;
  invalidateRelease: (projectId: string, releaseId: string) => Promise<void>;
  invalidateSecretTokens: (projectId: string) => Promise<void>;
  invalidateProjectMetrics: (projectId: string) => Promise<void>;
  invalidateIssues: (projectId: string) => Promise<void>;
  invalidateIssue: (issueId: string) => Promise<void>;
  invalidateIssueReproductions: (issueId: string) => Promise<void>;
  invalidateReproduction: (reproductionId: string) => Promise<void>;
  invalidateSessions: (projectId: string) => Promise<void>;
  invalidateSession: (sessionId: string) => Promise<void>;
  invalidateTags: (projectId: string) => Promise<void>;
  invalidateWorkspaceMembers: (workspaceId: string) => Promise<void>;
  invalidateNotifications: () => Promise<void>;
  clearSensitiveCache: () => void;
} {
  const client = useQueryClient();
  return {
    invalidateWorkspaces: () =>
      client.invalidateQueries({ queryKey: queryKeys.workspaces }),
    invalidateWorkspace: (id: string) =>
      client.invalidateQueries({ queryKey: queryKeys.workspace(id) }),
    invalidateProjects: (workspaceId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) }),
    invalidateProject: (id: string) =>
      client.invalidateQueries({ queryKey: queryKeys.project(id) }),
    invalidateEnvironments: (projectId: string) =>
      client.invalidateQueries({
        queryKey: queryKeys.environments(projectId),
      }),
    invalidateOrigins: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.origins(projectId) }),
    invalidateKeys: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.keys(projectId) }),
    invalidateReleases: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.releases(projectId) }),
    invalidateRelease: (projectId: string, releaseId: string) =>
      client.invalidateQueries({
        queryKey: queryKeys.release(projectId, releaseId),
      }),
    invalidateSecretTokens: (projectId: string) =>
      client.invalidateQueries({
        queryKey: queryKeys.secretTokens(projectId),
      }),
    invalidateProjectMetrics: (projectId: string) =>
      client.invalidateQueries({
        queryKey: ["projects", projectId, "metrics"],
      }),
    invalidateIssues: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.issues(projectId) }),
    invalidateIssue: (issueId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.issue(issueId) }),
    invalidateIssueReproductions: (issueId: string) =>
      client.invalidateQueries({
        queryKey: ["issues", issueId, "reproductions"],
      }),
    invalidateReproduction: (reproductionId: string) =>
      client.invalidateQueries({
        queryKey: queryKeys.reproduction(reproductionId),
      }),
    invalidateSessions: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.sessions(projectId) }),
    invalidateSession: (sessionId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.session(sessionId) }),
    invalidateTags: (projectId: string) =>
      client.invalidateQueries({ queryKey: queryKeys.tags(projectId) }),
    invalidateWorkspaceMembers: (workspaceId: string) =>
      client.invalidateQueries({
        queryKey: queryKeys.workspaceMembers(workspaceId),
      }),
    invalidateNotifications: () =>
      client.invalidateQueries({ queryKey: ["notifications"] }),
    clearSensitiveCache: () => {
      client.removeQueries({ queryKey: queryKeys.me });
      client.removeQueries({ queryKey: queryKeys.workspaces });
    },
  };
}
