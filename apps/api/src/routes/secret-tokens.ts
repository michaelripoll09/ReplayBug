import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  createSecretToken,
  listSecretTokens,
  revokeSecretToken,
} from "../services/secret-tokens.js";

export interface SecretTokenRouteDeps {
  db: Database;
  auth: Auth;
}

const secretTokenMetaJson = {
  type: "object",
  required: [
    "id",
    "projectId",
    "kind",
    "name",
    "prefix",
    "createdAt",
    "lastUsedAt",
    "revokedAt",
  ],
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

const secretTokenCreationJson = {
  type: "object",
  required: ["id", "projectId", "kind", "name", "prefix", "token", "createdAt"],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    token: { type: "string" },
    createdAt: { type: "string" },
    lastUsedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] },
  },
} as const;

const createBodyJson = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
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
 * Secret tokens: list metadata, create (full token returned ONE time in the
 * 201 body, never again), and revoke. Every operation requires the
 * `project:manage-secret-tokens` capability (owner/admin). Responses carry
 * metadata only — hashes and plaintext never leave the creation body.
 * Tags: SecretTokens.
 */
export async function registerSecretTokenRoutes(
  app: AppInstance,
  deps: SecretTokenRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/secret-tokens",
    {
      schema: {
        tags: ["SecretTokens"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "array", items: secretTokenMetaJson },
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
        const params = request.params as { projectId: string };
        const items = await listSecretTokens(
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
    "/api/v1/projects/:projectId/secret-tokens",
    {
      schema: {
        tags: ["SecretTokens"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        body: createBodyJson,
        response: {
          201: secretTokenCreationJson,
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
        const params = request.params as { projectId: string };
        const body = request.body as { name?: unknown };
        const created = await createSecretToken(
          deps.db,
          user.id,
          params.projectId,
          {
            name: body.name,
          },
        );
        await reply.status(201).send(created);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/secret-tokens/:tokenId/revoke",
    {
      schema: {
        tags: ["SecretTokens"],
        params: {
          type: "object",
          required: ["projectId", "tokenId"],
          properties: {
            projectId: { type: "string", format: "uuid" },
            tokenId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: secretTokenMetaJson,
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
          projectId: string;
          tokenId: string;
        };
        const revoked = await revokeSecretToken(
          deps.db,
          user.id,
          params.projectId,
          params.tokenId,
        );
        await reply.send(revoked);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
