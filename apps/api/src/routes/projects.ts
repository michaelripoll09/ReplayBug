import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  updateProject,
} from "../services/projects.js";

export interface ProjectRouteDeps {
  db: Database;
  auth: Auth;
}

const projectJson = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "name",
    "slug",
    "timezone",
    "retentionDays",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    workspaceId: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: ["string", "null"] },
    timezone: { type: "string" },
    retentionDays: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

const bootstrapJson = {
  type: "object",
  required: [
    "key",
    "prefix",
    "projectId",
    "ingestEndpoint",
    "ingestEnabled",
    "note",
  ],
  properties: {
    key: { type: "string" },
    prefix: { type: "string" },
    projectId: { type: "string" },
    ingestEndpoint: { type: "string" },
    ingestEnabled: { type: "boolean" },
    note: { type: "string" },
  },
} as const;

const projectWithBootstrapJson = {
  type: "object",
  required: ["project", "bootstrap"],
  properties: {
    project: projectJson,
    bootstrap: bootstrapJson,
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
 * Projects: nested under workspaces + direct by-id + transactional idempotent delete.
 * POST returns a bootstrap section with the one-time plaintext key, prefix,
 * projectId and an explicitly FUTURE ingest endpoint marked non-functional.
 * Tags: Projects.
 */
export async function registerProjectRoutes(
  app: AppInstance,
  deps: ProjectRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/workspaces/:workspaceId/projects",
    {
      schema: {
        tags: ["Projects"],
        params: {
          type: "object",
          required: ["workspaceId"],
          properties: { workspaceId: { type: "string", format: "uuid" } },
        },
        response: { 200: { type: "array", items: projectJson } },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { workspaceId: string };
        const items = await listProjects(deps.db, user.id, params.workspaceId);
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects",
    {
      schema: {
        tags: ["Projects"],
        params: {
          type: "object",
          required: ["workspaceId"],
          properties: { workspaceId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            slug: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: "string", maxLength: 2000 },
            timezone: { type: "string", maxLength: 100 },
            retentionDays: { type: "number" },
          },
        },
        response: {
          201: projectWithBootstrapJson,
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
        const params = request.params as { workspaceId: string };
        const parsed = createProjectRequestSchema.parse(request.body);
        const result = await createProject(
          deps.db,
          user.id,
          params.workspaceId,
          {
            name: parsed.name,
            ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
            ...(parsed.description !== undefined
              ? { description: parsed.description }
              : {}),
            ...(parsed.timezone !== undefined
              ? { timezone: parsed.timezone }
              : {}),
            ...(parsed.retentionDays !== undefined
              ? { retentionDays: parsed.retentionDays }
              : {}),
          },
        );
        await reply.status(201).send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:id",
    {
      schema: {
        tags: ["Projects"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: { 200: projectJson, 401: errorJson, 404: errorJson },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { id: string };
        const item = await getProjectById(deps.db, user.id, params.id);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/projects/:id",
    {
      schema: {
        tags: ["Projects"],
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
            slug: { type: "string", minLength: 1, maxLength: 100 },
            description: { type: ["string", "null"], maxLength: 2000 },
            timezone: { type: "string", maxLength: 100 },
            retentionDays: { type: "number" },
          },
        },
        response: {
          200: projectJson,
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
        const parsed = updateProjectRequestSchema.parse(request.body);
        const updated = await updateProject(deps.db, user.id, params.id, {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
          ...(parsed.description !== undefined
            ? { description: parsed.description }
            : {}),
          ...(parsed.timezone !== undefined
            ? { timezone: parsed.timezone }
            : {}),
          ...(parsed.retentionDays !== undefined
            ? { retentionDays: parsed.retentionDays }
            : {}),
        });
        await reply.send(updated);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/projects/:id",
    {
      schema: {
        tags: ["Projects"],
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
        const result = await deleteProject(deps.db, user.id, params.id);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
