import { aiAnalysisListQuerySchema } from "@replaybug/contracts";
import type { Database, DbClient } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired, validationError } from "../errors.js";
import { RATE_LIMIT_POLICIES } from "../plugins/rate-limit.js";
import {
  getAiAnalysisById,
  listIssueAiAnalyses,
  requestAiAnalysis,
} from "../services/ai-analyses.js";
import type { ApiConfig } from "../config.js";

export interface AiAnalysisRouteDeps {
  db: Database;
  dbClient: DbClient;
  auth: Auth;
  config: Pick<ApiConfig, "aiAnalysis">;
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

const requestedByJson = {
  type: "object",
  required: ["id", "email", "name"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
  },
} as const;

const aiAnalysisSummaryJson = {
  type: "object",
  required: [
    "id",
    "eventId",
    "model",
    "status",
    "analysisVersion",
    "requestedBy",
    "createdAt",
    "completedAt",
  ],
  properties: {
    id: { type: "string" },
    eventId: { type: ["string", "null"] },
    model: { type: "string" },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
    analysisVersion: { type: "string" },
    requestedBy: { anyOf: [requestedByJson, { type: "null" }] },
    createdAt: { type: "string" },
    completedAt: { type: ["string", "null"] },
  },
} as const;

const aiAnalysisListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: aiAnalysisSummaryJson },
    nextCursor: { type: "string" },
  },
} as const;

const aiAnalysisDetailJson = {
  type: "object",
  required: [
    "id",
    "issueId",
    "eventId",
    "model",
    "status",
    "analysisVersion",
    "requestedBy",
    "createdAt",
    "completedAt",
    "summary",
    "suspectedCause",
    "evidence",
    "reproductionSteps",
    "limitations",
    "errorCode",
    "errorMessage",
  ],
  properties: {
    id: { type: "string" },
    issueId: { type: "string" },
    eventId: { type: ["string", "null"] },
    model: { type: "string" },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
    analysisVersion: { type: "string" },
    requestedBy: { anyOf: [requestedByJson, { type: "null" }] },
    createdAt: { type: "string" },
    completedAt: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
    suspectedCause: { type: ["string", "null"] },
    evidence: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            required: ["ref", "reason"],
            properties: {
              ref: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
        { type: "null" },
      ],
    },
    reproductionSteps: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    },
    limitations: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    },
    errorCode: { type: ["string", "null"] },
    errorMessage: { type: ["string", "null"] },
  },
} as const;

const createAiAnalysisResponseJson = {
  type: "object",
  required: ["id", "issueId", "eventId", "status"],
  properties: {
    id: { type: "string" },
    issueId: { type: "string" },
    eventId: { type: ["string", "null"] },
    status: { type: "string", enum: ["pending", "ready", "failed"] },
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
 * AI analysis lifecycle: request from an occurrence, list per-issue history,
 * fetch one detail. Tags: AI Analysis.
 */
export async function registerAiAnalysisRoutes(
  app: AppInstance,
  deps: AiAnalysisRouteDeps,
): Promise<void> {
  app.post(
    "/api/v1/events/:eventId/ai-analyses",
    {
      config: {
        // LLM-backed creation: slow and provider-billed (10/min).
        rateLimit: { ...RATE_LIMIT_POLICIES.aiAnalysisCreate },
      },
      schema: {
        tags: ["AI Analysis"],
        params: {
          type: "object",
          required: ["eventId"],
          properties: { eventId: { type: "string", format: "uuid" } },
        },
        response: {
          200: createAiAnalysisResponseJson,
          202: createAiAnalysisResponseJson,
          400: errorJson,
          401: errorJson,
          403: errorJson,
          404: errorJson,
          503: errorJson,
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
        const result = await requestAiAnalysis(
          { db: deps.db, config: deps.config },
          user.id,
          params.eventId,
          idempotencyKey,
        );
        await reply.status(result.deduplicated ? 200 : 202).send({
          id: result.id,
          issueId: result.issueId,
          eventId: result.eventId,
          status: result.status,
        });
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId/ai-analyses",
    {
      schema: {
        tags: ["AI Analysis"],
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
          200: aiAnalysisListJson,
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
        const parsed = aiAnalysisListQuerySchema.parse(request.query);
        const result = await listIssueAiAnalyses(
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
    "/api/v1/ai-analyses/:id",
    {
      schema: {
        tags: ["AI Analysis"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: aiAnalysisDetailJson,
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
        const item = await getAiAnalysisById(deps.dbClient, user.id, params.id);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
