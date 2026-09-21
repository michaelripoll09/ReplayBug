import { reproductionListQuerySchema } from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired, validationError } from "../errors.js";
import {
  getReproductionById,
  getReproductionDownload,
  listIssueReproductions,
  requestReproduction,
} from "../services/reproductions.js";

export interface ReproductionRouteDeps {
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

const reproductionGeneratedByJson = {
  type: "object",
  required: ["id", "email", "name"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
  },
} as const;

const reproductionSummaryJson = {
  type: "object",
  required: [
    "id",
    "eventId",
    "status",
    "hasRedactedSteps",
    "generatorVersion",
    "generatedBy",
    "createdAt",
    "completedAt",
  ],
  properties: {
    id: { type: "string" },
    eventId: { type: "string" },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
    hasRedactedSteps: { type: "boolean" },
    generatorVersion: { type: "string" },
    generatedBy: reproductionGeneratedByJson,
    createdAt: { type: "string" },
    completedAt: { type: ["string", "null"] },
  },
} as const;

const reproductionDetailJson = {
  type: "object",
  required: [
    "id",
    "eventId",
    "status",
    "hasRedactedSteps",
    "generatorVersion",
    "generatedBy",
    "createdAt",
    "completedAt",
    "issueId",
    "language",
    "framework",
    "code",
    "errorCode",
    "errorMessage",
  ],
  properties: {
    id: { type: "string" },
    eventId: { type: "string" },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
    hasRedactedSteps: { type: "boolean" },
    generatorVersion: { type: "string" },
    generatedBy: reproductionGeneratedByJson,
    createdAt: { type: "string" },
    completedAt: { type: ["string", "null"] },
    issueId: { type: "string" },
    language: { type: "string" },
    framework: { type: "string" },
    code: { type: ["string", "null"] },
    errorCode: { type: ["string", "null"] },
    errorMessage: { type: ["string", "null"] },
  },
} as const;

const createReproductionResponseJson = {
  type: "object",
  required: ["id", "issueId", "eventId", "status"],
  properties: {
    id: { type: "string" },
    issueId: { type: "string" },
    eventId: { type: "string" },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
  },
} as const;

const reproductionListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: reproductionSummaryJson },
    nextCursor: { type: "string" },
  },
} as const;

function getIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = headers["idempotency-key"];
  if (typeof raw !== "string" || raw.length === 0) {
    throw validationError("Idempotency-Key header is required");
  }
  return raw;
}

/**
 * Playwright reproductions: request generation from an occurrence, list
 * per-issue summaries (no code), fetch one detail, download ready code.
 * Tags: Reproductions.
 */
export async function registerReproductionRoutes(
  app: AppInstance,
  deps: ReproductionRouteDeps,
): Promise<void> {
  app.post(
    "/api/v1/events/:eventId/reproductions",
    {
      schema: {
        tags: ["Reproductions"],
        params: {
          type: "object",
          required: ["eventId"],
          properties: { eventId: { type: "string", format: "uuid" } },
        },
        response: {
          200: createReproductionResponseJson,
          202: createReproductionResponseJson,
          400: errorJson,
          401: errorJson,
          403: errorJson,
          404: errorJson,
          422: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const params = request.params as { eventId: string };
        const idempotencyKey = getIdempotencyKey(
          request.headers as Record<string, string | string[] | undefined>,
        );
        const { row, deduplicated } = await requestReproduction(
          deps.db,
          user.id,
          params.eventId,
          idempotencyKey,
        );
        const status =
          row.status === "pending" ||
          row.status === "ready" ||
          row.status === "failed"
            ? row.status
            : ("pending" as const);
        await reply.status(deduplicated ? 200 : 202).send({
          id: row.id,
          issueId: row.issueId,
          eventId: row.eventId ?? params.eventId,
          status,
        });
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId/reproductions",
    {
      schema: {
        tags: ["Reproductions"],
        params: {
          type: "object",
          required: ["issueId"],
          properties: { issueId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: {
          200: reproductionListJson,
          400: errorJson,
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
        const params = request.params as { issueId: string };
        const parsed = reproductionListQuerySchema.parse(request.query);
        const result = await listIssueReproductions(
          deps.db,
          user.id,
          params.issueId,
          parsed,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/reproductions/:reproductionId",
    {
      schema: {
        tags: ["Reproductions"],
        params: {
          type: "object",
          required: ["reproductionId"],
          properties: { reproductionId: { type: "string", format: "uuid" } },
        },
        response: {
          200: reproductionDetailJson,
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
        const params = request.params as { reproductionId: string };
        const item = await getReproductionById(
          deps.db,
          user.id,
          params.reproductionId,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/reproductions/:reproductionId/download",
    {
      schema: {
        tags: ["Reproductions"],
        params: {
          type: "object",
          required: ["reproductionId"],
          properties: { reproductionId: { type: "string", format: "uuid" } },
        },
        response: {
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
        const params = request.params as { reproductionId: string };
        const { code, filename } = await getReproductionDownload(
          deps.db,
          user.id,
          params.reproductionId,
        );
        await reply
          .header("content-type", "text/plain; charset=utf-8")
          .header("content-disposition", `attachment; filename="${filename}"`)
          .send(code);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
