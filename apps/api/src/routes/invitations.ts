import { createWorkspaceInvitationRequestSchema } from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from "../services/invitations.js";

export interface InvitationRouteDeps {
  db: Database;
  auth: Auth;
  webUrl: string;
}

const invitationJson = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "email",
    "role",
    "tokenPrefix",
    "status",
    "expiresAt",
    "acceptedAt",
    "revokedAt",
    "createdByUserId",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    role: { type: "string", enum: ["admin", "member", "viewer"] },
    tokenPrefix: { type: "string", pattern: "^[0-9a-f]{8}$" },
    status: {
      type: "string",
      enum: ["pending", "expired", "accepted", "revoked"],
    },
    expiresAt: { type: "string", format: "date-time" },
    acceptedAt: { type: ["string", "null"], format: "date-time" },
    revokedAt: { type: ["string", "null"], format: "date-time" },
    createdByUserId: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
} as const;

const createInvitationJson = {
  type: "object",
  required: ["email", "role"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 320 },
    role: { type: "string", enum: ["admin", "member", "viewer"] },
  },
  additionalProperties: false,
} as const;

const createInvitationResponseJson = {
  type: "object",
  required: [
    "id",
    "workspaceId",
    "email",
    "role",
    "tokenPrefix",
    "status",
    "expiresAt",
    "acceptedAt",
    "revokedAt",
    "createdByUserId",
    "createdAt",
    "token",
    "inviteUrl",
    "deliveryNote",
  ],
  properties: {
    ...invitationJson.properties,
    token: {
      type: "string",
      pattern: "^rb_inv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$",
    },
    inviteUrl: { type: "string", format: "uri" },
    deliveryNote: { type: "string" },
  },
  additionalProperties: false,
} as const;

const acceptInvitationJson = {
  type: "object",
  required: [
    "invitationId",
    "workspaceId",
    "membershipId",
    "role",
    "acceptedAt",
  ],
  properties: {
    invitationId: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    membershipId: { type: "string", format: "uuid" },
    role: { type: "string", enum: ["admin", "member", "viewer"] },
    acceptedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
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

const workspaceParams = {
  type: "object",
  required: ["workspaceId"],
  properties: { workspaceId: { type: "string", format: "uuid" } },
} as const;

/** Authenticated workspace invitation lifecycle. Tags: Invitations. */
export async function registerInvitationRoutes(
  app: AppInstance,
  deps: InvitationRouteDeps,
): Promise<void> {
  app.post(
    "/api/v1/workspaces/:workspaceId/invitations",
    {
      schema: {
        tags: ["Invitations"],
        params: workspaceParams,
        body: createInvitationJson,
        response: {
          201: createInvitationResponseJson,
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
        const parsed = createWorkspaceInvitationRequestSchema.parse(
          request.body,
        );
        const created = await createWorkspaceInvitation(
          deps.db,
          user.id,
          params.workspaceId,
          parsed,
          deps.webUrl,
        );
        await reply.status(201).send(created);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/invitations",
    {
      schema: {
        tags: ["Invitations"],
        params: workspaceParams,
        response: {
          200: { type: "array", items: invitationJson },
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
        const items = await listWorkspaceInvitations(
          deps.db,
          user.id,
          params.workspaceId,
        );
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    {
      schema: {
        tags: ["Invitations"],
        params: {
          type: "object",
          required: ["workspaceId", "invitationId"],
          properties: {
            workspaceId: { type: "string", format: "uuid" },
            invitationId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: invitationJson,
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
          invitationId: string;
        };
        const revoked = await revokeWorkspaceInvitation(
          deps.db,
          user.id,
          params.workspaceId,
          params.invitationId,
        );
        await reply.send(revoked);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/invitations/:token/accept",
    {
      schema: {
        tags: ["Invitations"],
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: {
              type: "string",
              pattern: "^rb_inv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$",
            },
          },
        },
        response: {
          200: acceptInvitationJson,
          400: errorJson,
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
        const params = request.params as { token: string };
        const accepted = await acceptWorkspaceInvitation(
          deps.db,
          user.id,
          user.email,
          params.token,
        );
        await reply.send(accepted);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
