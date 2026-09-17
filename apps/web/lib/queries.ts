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
};

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

/** Invalidate exactly one domain list/detail after a mutation. */
export function useInvalidateDomain(): {
  invalidateWorkspaces: () => Promise<void>;
  invalidateWorkspace: (id: string) => Promise<void>;
  invalidateProjects: (workspaceId: string) => Promise<void>;
  invalidateProject: (id: string) => Promise<void>;
  invalidateEnvironments: (projectId: string) => Promise<void>;
  invalidateOrigins: (projectId: string) => Promise<void>;
  invalidateKeys: (projectId: string) => Promise<void>;
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
    clearSensitiveCache: () => {
      client.removeQueries({ queryKey: queryKeys.me });
      client.removeQueries({ queryKey: queryKeys.workspaces });
    },
  };
}
