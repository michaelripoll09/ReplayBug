import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  getDashboardRelease,
  listDashboardReleases,
} from "../services/dashboard-releases.js";

export interface DashboardReleaseRouteDeps {
  db: Database;
  auth: Auth;
}

const dashboardReleaseJson = {
  type: "object",
  required: [
    "id",
    "version",
    "commitSha",
    "repositoryUrl",
    "createdAt",
    "artifactCount",
    "sourceMapCount",
    "minifiedAssetCount",
    "occurrenceCount",
    "hasSourceMaps",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    version: { type: "string" },
    commitSha: { type: ["string", "null"] },
    repositoryUrl: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    artifactCount: { type: "integer", minimum: 0 },
    sourceMapCount: { type: "integer", minimum: 0 },
    minifiedAssetCount: { type: "integer", minimum: 0 },
    occurrenceCount: { type: "integer", minimum: 0 },
    // Artifact status summary: true once a source map is stored.
    hasSourceMaps: { type: "boolean" },
  },
} as const;

const dashboardArtifactJson = {
  type: "object",
  required: [
    "id",
    "artifactPath",
    "artifactType",
    "contentHash",
    "sizeBytes",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    artifactPath: { type: "string" },
    artifactType: { type: "string", enum: ["source_map", "minified_asset"] },
    contentHash: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const dashboardReleaseDetailJson = {
  type: "object",
  required: [
    "id",
    "version",
    "commitSha",
    "repositoryUrl",
    "createdAt",
    "artifactCount",
    "sourceMapCount",
    "minifiedAssetCount",
    "occurrenceCount",
    "hasSourceMaps",
    "artifacts",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    version: { type: "string" },
    commitSha: { type: ["string", "null"] },
    repositoryUrl: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    artifactCount: { type: "integer", minimum: 0 },
    sourceMapCount: { type: "integer", minimum: 0 },
    minifiedAssetCount: { type: "integer", minimum: 0 },
    occurrenceCount: { type: "integer", minimum: 0 },
    hasSourceMaps: { type: "boolean" },
    artifacts: { type: "array", items: dashboardArtifactJson },
  },
} as const;

const errorJson = {
  type: "object",
  required: ["code", "message", "requestId"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    requestId: { type: "string" },
  },
} as const;

/**
 * RS-10 dashboard release reads (`/api/v1/projects/:projectId/releases`).
 *
 * Dashboard session auth ONLY: the caller authenticates with the Better Auth
 * session cookie and any project member (viewer and up, via `project:read`)
 * may read. CLI bearer tokens are never consulted here — token callers use
 * `/api/v1/cli/releases`. Responses carry counts plus artifact metadata;
 * `storage_key` values and file bytes are never exposed (there is no
 * source-map content endpoint in this build).
 * Tags: Releases.
 */
export async function registerDashboardReleaseRoutes(
  app: AppInstance,
  deps: DashboardReleaseRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/releases",
    {
      schema: {
        tags: ["Releases"],
        description:
          "List project releases with artifact and occurrence counts for the dashboard. Session auth; all project members may read.",
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "array", items: dashboardReleaseJson },
          401: errorJson,
          404: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { projectId: string };
        const items = await listDashboardReleases(
          deps.db,
          user.id,
          params.projectId,
        );
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/releases/:releaseId",
    {
      schema: {
        tags: ["Releases"],
        description:
          "Release detail with artifact metadata (path/type/hash/size, never storage keys or file bytes). Session auth; all project members may read.",
        params: {
          type: "object",
          required: ["projectId", "releaseId"],
          properties: {
            projectId: { type: "string", format: "uuid" },
            releaseId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: dashboardReleaseDetailJson,
          401: errorJson,
          404: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as {
          projectId: string;
          releaseId: string;
        };
        const item = await getDashboardRelease(
          deps.db,
          user.id,
          params.projectId,
          params.releaseId,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
