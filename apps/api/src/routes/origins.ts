import {
  createOriginRequestSchema,
  updateOriginRequestSchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import { addOrigin, removeOrigin, updateOrigin } from "../services/origins.js";
import { listOriginsForProject } from "../services/projects.js";

export interface OriginRouteDeps {
  db: Database;
  auth: Auth;
}

const originJson = {
  type: "object",
  required: [
    "id",
    "projectId",
    "origin",
    "isEnabled",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    origin: { type: "string" },
    isEnabled: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
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

/** Origins: read-all, write owner/admin. Tags: Origins. */
export async function registerOriginRoutes(
  app: AppInstance,
  deps: OriginRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/origins",
    {
      schema: {
        tags: ["Origins"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: { 200: { type: "array", items: originJson } },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { projectId: string };
        const items = await listOriginsForProject(
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

  app.post(
    "/api/v1/projects/:projectId/origins",
    {
      schema: {
        tags: ["Origins"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["origin"],
          properties: {
            origin: { type: "string", minLength: 1, maxLength: 2000 },
            isEnabled: { type: "boolean" },
          },
        },
        response: {
          201: originJson,
          400: errorJson,
          401: errorJson,
          403: errorJson,
          404: errorJson,
          409: errorJson,
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
        const parsed = createOriginRequestSchema.parse(request.body);
        const created = await addOrigin(deps.db, user.id, params.projectId, {
          origin: parsed.origin,
          ...(parsed.isEnabled !== undefined
            ? { isEnabled: parsed.isEnabled }
            : {}),
        });
        await reply.status(201).send(created);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/origins/:id",
    {
      schema: {
        tags: ["Origins"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          minProperties: 1,
          properties: {
            origin: { type: "string", minLength: 1, maxLength: 2000 },
            isEnabled: { type: "boolean" },
          },
        },
        response: {
          200: originJson,
          400: errorJson,
          401: errorJson,
          403: errorJson,
          404: errorJson,
          409: errorJson,
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
        const parsed = updateOriginRequestSchema.parse(request.body);
        const updated = await updateOrigin(deps.db, user.id, params.id, {
          ...(parsed.origin !== undefined ? { origin: parsed.origin } : {}),
          ...(parsed.isEnabled !== undefined
            ? { isEnabled: parsed.isEnabled }
            : {}),
        });
        await reply.send(updated);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/origins/:id",
    {
      schema: {
        tags: ["Origins"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            required: ["deleted"],
            properties: { deleted: { type: "boolean" } },
          },
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
        const result = await removeOrigin(deps.db, user.id, params.id);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
