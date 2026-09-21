import {
  createEnvironmentRequestSchema,
  updateEnvironmentRequestSchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
} from "../services/projects.js";

export interface EnvironmentRouteDeps {
  db: Database;
  auth: Auth;
}

const environmentJson = {
  type: "object",
  required: ["id", "projectId", "name", "isDefault", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    name: { type: "string" },
    baseUrl: { type: ["string", "null"] },
    isDefault: { type: "boolean" },
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

/** Environments: read-all, write owner/admin. Tags: Environments. */
export async function registerEnvironmentRoutes(
  app: AppInstance,
  deps: EnvironmentRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/environments",
    {
      schema: {
        tags: ["Environments"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: { 200: { type: "array", items: environmentJson } },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { projectId: string };
        const items = await listEnvironments(
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
    "/api/v1/projects/:projectId/environments",
    {
      schema: {
        tags: ["Environments"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            baseUrl: { type: "string", maxLength: 2000 },
            isDefault: { type: "boolean" },
          },
        },
        response: {
          201: environmentJson,
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
        const parsed = createEnvironmentRequestSchema.parse(request.body);
        const created = await createEnvironment(
          deps.db,
          user.id,
          params.projectId,
          {
            name: parsed.name,
            ...(parsed.baseUrl !== undefined
              ? { baseUrl: parsed.baseUrl }
              : {}),
            ...(parsed.isDefault !== undefined
              ? { isDefault: parsed.isDefault }
              : {}),
          },
        );
        await reply.status(201).send(created);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/environments/:id",
    {
      schema: {
        tags: ["Environments"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            baseUrl: { type: ["string", "null"], maxLength: 2000 },
            isDefault: { type: "boolean" },
          },
        },
        response: {
          200: environmentJson,
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
        const parsed = updateEnvironmentRequestSchema.parse(request.body);
        const updated = await updateEnvironment(deps.db, user.id, params.id, {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
          ...(parsed.isDefault !== undefined
            ? { isDefault: parsed.isDefault }
            : {}),
        });
        await reply.send(updated);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/environments/:id",
    {
      schema: {
        tags: ["Environments"],
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
        const result = await deleteEnvironment(deps.db, user.id, params.id);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
