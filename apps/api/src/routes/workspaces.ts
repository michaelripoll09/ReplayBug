import {
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  createWorkspace,
  getWorkspace,
  listMyWorkspaces,
  listWorkspaceMembers,
  updateWorkspace,
} from "../services/workspaces.js";

export interface WorkspaceRouteDeps {
  db: Database;
  auth: Auth;
}

const workspaceJson = {
  type: "object",
  required: ["id", "name", "slug", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

const workspaceWithRoleJson = {
  type: "object",
  required: ["id", "name", "slug", "createdAt", "updatedAt", "role"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
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

const workspaceMemberJson = {
  type: "object",
  required: ["id", "name", "email", "role"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
  },
} as const;

/** Workspaces: list-mine, create, get one, update. No delete this block. Tags: Workspaces. */
export async function registerWorkspaceRoutes(
  app: AppInstance,
  deps: WorkspaceRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/workspaces",
    {
      schema: {
        tags: ["Workspaces"],
        response: { 200: { type: "array", items: workspaceWithRoleJson } },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const items = await listMyWorkspaces(deps.db, user.id);
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/workspaces",
    {
      schema: {
        tags: ["Workspaces"],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            slug: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        response: {
          201: workspaceJson,
          400: errorJson,
          401: errorJson,
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
        const parsed = createWorkspaceRequestSchema.parse(request.body);
        const created = await createWorkspace(deps.db, user.id, {
          name: parsed.name,
          ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
        });
        await reply.status(201).send(created);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:id",
    {
      schema: {
        tags: ["Workspaces"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: workspaceWithRoleJson,
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
        const params = request.params as { id: string };
        const item = await getWorkspace(deps.db, user.id, params.id);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/workspaces/:id",
    {
      schema: {
        tags: ["Workspaces"],
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
          },
        },
        response: {
          200: workspaceJson,
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
        const parsed = updateWorkspaceRequestSchema.parse(request.body);
        const updated = await updateWorkspace(deps.db, user.id, params.id, {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
        });
        await reply.send(updated);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:id/members",
    {
      schema: {
        tags: ["Workspaces"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "array", items: workspaceMemberJson },
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
        const params = request.params as { id: string };
        const items = await listWorkspaceMembers(deps.db, user.id, params.id);
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
