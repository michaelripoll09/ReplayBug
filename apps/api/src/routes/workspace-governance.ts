import {
  WORKSPACE_AUDIT_ACTIONS,
  transferWorkspaceOwnershipRequestSchema,
  updateWorkspaceMemberRoleRequestSchema,
  workspaceAuditQuerySchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { authRequired } from "../errors.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import {
  leaveWorkspace,
  listWorkspaceAudit,
  removeWorkspaceMember,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
} from "../services/workspace-governance.js";

export interface WorkspaceGovernanceRouteDeps {
  db: Database;
  auth: Auth;
}

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
    email: { type: "string", format: "email" },
    role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
  },
  additionalProperties: false,
} as const;

const workspaceMemberRoleRequestJson = {
  type: "object",
  required: ["role"],
  properties: {
    role: { type: "string", enum: ["admin", "member", "viewer"] },
  },
  additionalProperties: false,
} as const;

const removedJson = {
  type: "object",
  required: ["removed"],
  properties: { removed: { type: "boolean", const: true } },
  additionalProperties: false,
} as const;

const leftJson = {
  type: "object",
  required: ["left"],
  properties: { left: { type: "boolean", const: true } },
  additionalProperties: false,
} as const;

const transferRequestJson = {
  type: "object",
  required: ["userId"],
  properties: { userId: { type: "string", minLength: 1, maxLength: 200 } },
  additionalProperties: false,
} as const;

const transferResponseJson = {
  type: "object",
  required: ["workspaceId", "previousOwnerId", "newOwnerId"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    previousOwnerId: { type: "string" },
    newOwnerId: { type: "string" },
  },
  additionalProperties: false,
} as const;

const userSummaryJson = {
  type: "object",
  required: ["id", "email", "name", "emailVerified"],
  properties: {
    id: { type: "string" },
    email: { type: "string", format: "email" },
    name: { type: "string" },
    image: { type: ["string", "null"] },
    emailVerified: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const auditEventJson = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "projectId",
    "action",
    "actor",
    "metadata",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    projectId: { type: ["string", "null"], format: "uuid" },
    action: { type: "string", enum: [...WORKSPACE_AUDIT_ACTIONS] },
    actor: { anyOf: [userSummaryJson, { type: "null" }] },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

const auditPageJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: auditEventJson },
    nextCursor: { type: "string" },
  },
  additionalProperties: false,
} as const;

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", format: "uuid" } },
} as const;

const memberParams = {
  type: "object",
  required: ["workspaceId", "userId"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    userId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

/** Authenticated workspace membership mutations and audit access. */
export async function registerWorkspaceGovernanceRoutes(
  app: AppInstance,
  deps: WorkspaceGovernanceRouteDeps,
): Promise<void> {
  app.patch(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        tags: ["Workspaces"],
        params: memberParams,
        body: workspaceMemberRoleRequestJson,
        response: {
          200: workspaceMemberJson,
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
        const params = request.params as {
          workspaceId: string;
          userId: string;
        };
        const input = updateWorkspaceMemberRoleRequestSchema.parse(
          request.body,
        );
        const member = await updateWorkspaceMemberRole(
          deps.db,
          user.id,
          params.workspaceId,
          params.userId,
          input,
        );
        await reply.send(member);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        tags: ["Workspaces"],
        params: memberParams,
        response: {
          200: removedJson,
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
        const params = request.params as {
          workspaceId: string;
          userId: string;
        };
        const result = await removeWorkspaceMember(
          deps.db,
          user.id,
          params.workspaceId,
          params.userId,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/leave",
    {
      schema: {
        tags: ["Workspaces"],
        params: workspaceParams,
        response: {
          200: leftJson,
          401: errorJson,
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
        const result = await leaveWorkspace(
          deps.db,
          user.id,
          params.workspaceId,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/ownership-transfer",
    {
      schema: {
        tags: ["Workspaces"],
        params: workspaceParams,
        body: transferRequestJson,
        response: {
          200: transferResponseJson,
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
        const input = transferWorkspaceOwnershipRequestSchema.parse(
          request.body,
        );
        const result = await transferWorkspaceOwnership(
          deps.db,
          user.id,
          params.workspaceId,
          input,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/audit",
    {
      schema: {
        tags: ["Workspaces"],
        params: workspaceParams,
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            cursor: { type: "string", maxLength: 256 },
            action: { type: "string", enum: [...WORKSPACE_AUDIT_ACTIONS] },
          },
          additionalProperties: false,
        },
        response: {
          200: auditPageJson,
          400: errorJson,
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
        const params = request.params as { workspaceId: string };
        const query = workspaceAuditQuerySchema.parse(request.query);
        const result = await listWorkspaceAudit(
          deps.db,
          user.id,
          params.workspaceId,
          query,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
