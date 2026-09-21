import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import { listKeyMetadata, rotatePublicIngestKey } from "../services/keys.js";

export interface KeyRouteDeps {
  db: Database;
  auth: Auth;
}

const keyMetaJson = {
  type: "object",
  required: ["id", "projectId", "kind", "name", "prefix", "createdAt"],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    createdAt: { type: "string" },
    lastUsedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] },
  },
} as const;

const keyCreationJson = {
  type: "object",
  required: ["id", "projectId", "kind", "name", "prefix", "key", "createdAt"],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    key: { type: "string" },
    createdAt: { type: "string" },
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
 * Keys: metadata is listable; full key is returned ONE time on rotate and
 * never re-displayed. Tags: Keys.
 */
export async function registerKeyRoutes(
  app: AppInstance,
  deps: KeyRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/keys",
    {
      schema: {
        tags: ["Keys"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: { 200: { type: "array", items: keyMetaJson } },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { projectId: string };
        const items = await listKeyMetadata(deps.db, user.id, params.projectId);
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/projects/:id/keys/public/rotate",
    {
      schema: {
        tags: ["Keys"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: keyCreationJson,
          401: errorJson,
          403: errorJson,
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
        const params = request.params as { id: string };
        const rotated = await rotatePublicIngestKey(
          deps.db,
          user.id,
          params.id,
        );
        await reply.send(rotated);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
