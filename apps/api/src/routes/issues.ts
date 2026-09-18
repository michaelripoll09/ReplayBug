import {
  activityListQuerySchema,
  commentListQuerySchema,
  createCommentRequestSchema,
  createTagRequestSchema,
  issueListQuerySchema,
  metricsQuerySchema,
  occurrenceListQuerySchema,
  updateCommentRequestSchema,
  updateIssueAssigneeRequestSchema,
  updateIssueStatusRequestSchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  assignIssueTag,
  createIssueComment,
  createProjectTag,
  getEventById,
  getIssueById,
  getProjectMetrics,
  listIssueActivity,
  listIssueComments,
  listIssueOccurrences,
  listIssues,
  listProjectTags,
  unassignIssueTag,
  updateIssueAssignee,
  updateIssueComment,
  updateIssueStatus,
} from "../services/issues.js";

export interface IssueRouteDeps {
  db: Database;
  auth: Auth;
}

const userSummaryJson = {
  type: "object",
  required: ["id", "email", "name", "emailVerified"],
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    image: { type: ["string", "null"] },
    emailVerified: { type: "boolean" },
  },
} as const;

const issueTagSummaryJson = {
  type: "object",
  required: ["id", "name", "slug"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
  },
} as const;

export const issueSummaryJson = {
  type: "object",
  required: [
    "id",
    "projectId",
    "type",
    "title",
    "normalizedMessage",
    "status",
    "severity",
    "assignee",
    "firstSeenAt",
    "lastSeenAt",
    "resolvedAt",
    "firstRelease",
    "lastRelease",
    "occurrenceCount",
    "affectedSessionCount",
    "tags",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    normalizedMessage: { type: "string" },
    status: { type: "string" },
    severity: { type: "string" },
    assignee: { anyOf: [userSummaryJson, { type: "null" }] },
    firstSeenAt: { type: "string" },
    lastSeenAt: { type: "string" },
    resolvedAt: { type: ["string", "null"] },
    firstRelease: { type: ["string", "null"] },
    lastRelease: { type: ["string", "null"] },
    occurrenceCount: { type: "number" },
    affectedSessionCount: { type: "number" },
    tags: { type: "array", items: issueTagSummaryJson },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

const issueListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: issueSummaryJson },
    nextCursor: { type: "string" },
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

const issueTagJson = {
  type: "object",
  required: ["id", "projectId", "name", "slug", "createdAt"],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    name: { type: "string" },
    slug: { type: "string" },
    createdAt: { type: "string" },
  },
} as const;

const issueCommentJson = {
  type: "object",
  required: [
    "id",
    "issueId",
    "author",
    "bodyMarkdown",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    issueId: { type: "string" },
    author: userSummaryJson,
    bodyMarkdown: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

const commentListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: issueCommentJson },
    nextCursor: { type: "string" },
  },
} as const;

const removedJson = {
  type: "object",
  required: ["removed"],
  properties: { removed: { type: "boolean" } },
} as const;

const issueActivityJson = {
  type: "object",
  required: ["id", "issueId", "type", "actor", "metadata", "createdAt"],
  properties: {
    id: { type: "string" },
    issueId: { type: "string" },
    type: { type: "string" },
    actor: { anyOf: [userSummaryJson, { type: "null" }] },
    // Safe transition hints ({from,to}, {userId}, {commentId}) written by
    // services. additionalProperties keeps them: fast-json-stringify drops
    // undeclared keys from plain `type: object` (serializes as {}).
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
} as const;

const activityListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: issueActivityJson },
    nextCursor: { type: "string" },
  },
} as const;

const occurrenceJson = {
  type: "object",
  required: [
    "eventId",
    "sessionId",
    "occurredAt",
    "receivedAt",
    "environment",
    "release",
    "pageUrl",
    "eventType",
    "processingState",
  ],
  properties: {
    eventId: { type: "string" },
    sessionId: { type: "string" },
    occurredAt: { type: "string" },
    receivedAt: { type: "string" },
    environment: { type: "string" },
    release: { type: ["string", "null"] },
    pageUrl: { type: ["string", "null"] },
    eventType: { type: "string" },
    processingState: { type: "string" },
  },
} as const;

const occurrenceListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: occurrenceJson },
    nextCursor: { type: "string" },
  },
} as const;

const safeFrameJson = {
  type: "object",
  properties: {
    filename: { type: "string" },
    function: { type: "string" },
    lineno: { type: "number" },
    colno: { type: "number" },
    inApp: { type: "boolean" },
  },
} as const;

const eventDataJson = {
  anyOf: [
    {
      type: "object",
      required: ["values"],
      properties: {
        values: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "value"],
            properties: {
              type: { type: "string" },
              value: { type: "string" },
              stacktrace: {
                type: "object",
                required: ["frames"],
                properties: {
                  frames: { type: "array", items: safeFrameJson },
                },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string" } },
    },
    {
      type: "object",
      required: ["args"],
      properties: { args: { type: "array", items: { type: "string" } } },
    },
    {
      type: "object",
      required: ["url", "method", "statusCode", "durationMs"],
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        statusCode: { type: ["number", "null"] },
        durationMs: { type: "number" },
        failureType: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["message", "level"],
      properties: {
        message: { type: "string" },
        level: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["toUrl", "navigationType"],
      properties: {
        fromUrl: { type: ["string", "null"] },
        toUrl: { type: "string" },
        navigationType: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["locatorCandidates", "elementTag"],
      properties: {
        locatorCandidates: {
          type: "array",
          items: {
            type: "object",
            required: ["type", "value", "confidence"],
            properties: {
              type: { type: "string" },
              value: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
        elementTag: { type: "string" },
        elementRole: { type: "string" },
        accessibleName: { type: "string" },
        route: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["inputType", "hasValue"],
      properties: {
        inputType: { type: "string" },
        inputName: { type: "string" },
        hasValue: { type: "boolean" },
      },
    },
    {
      type: "object",
      required: ["category", "message", "level"],
      properties: {
        category: { type: "string" },
        message: { type: "string" },
        level: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["sdkName", "sdkVersion", "event"],
      properties: {
        sdkName: { type: "string" },
        sdkVersion: { type: "string" },
        event: { type: "string" },
      },
    },
  ],
} as const;

const eventDetailJson = {
  type: "object",
  required: [
    "eventId",
    "sessionId",
    "issueId",
    "eventType",
    "occurredAt",
    "receivedAt",
    "environment",
    "release",
    "pageUrl",
    "processingState",
    "data",
  ],
  properties: {
    eventId: { type: "string" },
    sessionId: { type: "string" },
    issueId: { type: ["string", "null"] },
    eventType: { type: "string" },
    occurredAt: { type: "string" },
    receivedAt: { type: "string" },
    environment: { type: "string" },
    release: { type: ["string", "null"] },
    pageUrl: { type: ["string", "null"] },
    processingState: { type: "string" },
    data: eventDataJson,
  },
} as const;

const metricsJson = {
  type: "object",
  required: [
    "range",
    "bucketStart",
    "bucketEnd",
    "bucketSize",
    "unresolvedCount",
    "newIssueCount",
    "occurrenceCount",
    "affectedSessionCount",
    "regressionCount",
    "topIssues",
    "overTime",
    "byEnvironment",
    "byRelease",
  ],
  properties: {
    range: { type: "string" },
    bucketStart: { type: "string" },
    bucketEnd: { type: "string" },
    bucketSize: { type: "string" },
    unresolvedCount: { type: "number" },
    newIssueCount: { type: "number" },
    occurrenceCount: { type: "number" },
    affectedSessionCount: { type: "number" },
    regressionCount: { type: "number" },
    topIssues: {
      type: "array",
      items: {
        type: "object",
        required: ["issueId", "title", "occurrences"],
        properties: {
          issueId: { type: "string" },
          title: { type: "string" },
          occurrences: { type: "number" },
        },
      },
    },
    overTime: {
      type: "array",
      items: {
        type: "object",
        required: ["bucketStart", "occurrences", "newIssues"],
        properties: {
          bucketStart: { type: "string" },
          occurrences: { type: "number" },
          newIssues: { type: "number" },
        },
      },
    },
    byEnvironment: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "occurrences"],
        properties: {
          key: { type: "string" },
          occurrences: { type: "number" },
        },
      },
    },
    byRelease: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "occurrences"],
        properties: {
          key: { type: "string" },
          occurrences: { type: "number" },
        },
      },
    },
  },
} as const;

/**
 * Issue list: project-scoped filters/sort with stable keyset pagination.
 * Tags: Issues.
 */
export async function registerIssueRoutes(
  app: AppInstance,
  deps: IssueRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/issues",
    {
      schema: {
        tags: ["Issues"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["open", "investigating", "resolved", "ignored"],
            },
            environment: { type: "string" },
            release: { type: "string" },
            type: {
              type: "string",
              enum: [
                "exception",
                "unhandled_rejection",
                "console_error",
                "network",
                "message",
              ],
            },
            assigneeId: { type: "string" },
            unassigned: { type: "string" },
            tag: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            q: { type: "string" },
            sort: {
              type: "string",
              enum: [
                "last_seen",
                "first_seen",
                "occurrence_count",
                "affected_sessions",
              ],
            },
            order: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: {
          200: issueListJson,
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
        const params = request.params as { projectId: string };
        const parsed = issueListQuerySchema.parse(request.query);
        const result = await listIssues(
          deps.db,
          user.id,
          params.projectId,
          parsed,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/metrics",
    {
      schema: {
        tags: ["Metrics"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            range: { type: "string", enum: ["24h", "7d", "30d"] },
          },
        },
        response: {
          200: metricsJson,
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
        const params = request.params as { projectId: string };
        const parsed = metricsQuerySchema.parse(request.query);
        const result = await getProjectMetrics(
          deps.db,
          user.id,
          params.projectId,
          parsed,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId",
    {
      schema: {
        tags: ["Issues"],
        params: {
          type: "object",
          required: ["issueId"],
          properties: { issueId: { type: "string", format: "uuid" } },
        },
        response: {
          200: issueSummaryJson,
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
        const item = await getIssueById(deps.db, user.id, params.issueId);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId/occurrences",
    {
      schema: {
        tags: ["Issues"],
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
          200: occurrenceListJson,
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
        const parsed = occurrenceListQuerySchema.parse(request.query);
        const result = await listIssueOccurrences(
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
    "/api/v1/events/:eventId",
    {
      schema: {
        tags: ["Issues"],
        params: {
          type: "object",
          required: ["eventId"],
          properties: { eventId: { type: "string", format: "uuid" } },
        },
        response: {
          200: eventDetailJson,
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
        const params = request.params as { eventId: string };
        const item = await getEventById(deps.db, user.id, params.eventId);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/issues/:issueId/status",
    {
      schema: {
        tags: ["Issues"],
        params: {
          type: "object",
          required: ["issueId"],
          properties: { issueId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: ["open", "investigating", "resolved", "ignored"],
            },
          },
        },
        response: {
          200: issueSummaryJson,
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
        const params = request.params as { issueId: string };
        const parsed = updateIssueStatusRequestSchema.parse(request.body);
        const item = await updateIssueStatus(
          deps.db,
          user.id,
          params.issueId,
          parsed,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/issues/:issueId/assignee",
    {
      schema: {
        tags: ["Issues"],
        params: {
          type: "object",
          required: ["issueId"],
          properties: { issueId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["userId"],
          properties: { userId: { type: ["string", "null"] } },
        },
        response: {
          200: issueSummaryJson,
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
        const params = request.params as { issueId: string };
        const parsed = updateIssueAssigneeRequestSchema.parse(request.body);
        const item = await updateIssueAssignee(
          deps.db,
          user.id,
          params.issueId,
          parsed,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/projects/:projectId/tags",
    {
      schema: {
        tags: ["Tags"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "array", items: issueTagJson },
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
        const params = request.params as { projectId: string };
        const items = await listProjectTags(deps.db, user.id, params.projectId);
        await reply.send(items);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/projects/:projectId/tags",
    {
      schema: {
        tags: ["Tags"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 50 } },
        },
        response: {
          200: issueTagJson,
          201: issueTagJson,
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
        const parsed = createTagRequestSchema.parse(request.body);
        const result = await createProjectTag(
          deps.db,
          user.id,
          params.projectId,
          parsed,
        );
        await reply.status(result.created ? 201 : 200).send(result.tag);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.put(
    "/api/v1/issues/:issueId/tags/:tagId",
    {
      schema: {
        tags: ["Tags"],
        params: {
          type: "object",
          required: ["issueId", "tagId"],
          properties: {
            issueId: { type: "string", format: "uuid" },
            tagId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: issueTagJson,
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
        const params = request.params as { issueId: string; tagId: string };
        const item = await assignIssueTag(
          deps.db,
          user.id,
          params.issueId,
          params.tagId,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/issues/:issueId/tags/:tagId",
    {
      schema: {
        tags: ["Tags"],
        params: {
          type: "object",
          required: ["issueId", "tagId"],
          properties: {
            issueId: { type: "string", format: "uuid" },
            tagId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: removedJson,
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
        const params = request.params as { issueId: string; tagId: string };
        const result = await unassignIssueTag(
          deps.db,
          user.id,
          params.issueId,
          params.tagId,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId/comments",
    {
      schema: {
        tags: ["Comments"],
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
          200: commentListJson,
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
        const parsed = commentListQuerySchema.parse(request.query);
        const result = await listIssueComments(
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

  app.post(
    "/api/v1/issues/:issueId/comments",
    {
      schema: {
        tags: ["Comments"],
        params: {
          type: "object",
          required: ["issueId"],
          properties: { issueId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 10000 },
          },
        },
        response: {
          201: issueCommentJson,
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
        const params = request.params as { issueId: string };
        const parsed = createCommentRequestSchema.parse(request.body);
        const item = await createIssueComment(
          deps.db,
          user.id,
          params.issueId,
          parsed,
        );
        await reply.status(201).send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/issues/:issueId/comments/:commentId",
    {
      schema: {
        tags: ["Comments"],
        params: {
          type: "object",
          required: ["issueId", "commentId"],
          properties: {
            issueId: { type: "string", format: "uuid" },
            commentId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 10000 },
          },
        },
        response: {
          200: issueCommentJson,
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
        const params = request.params as {
          issueId: string;
          commentId: string;
        };
        const parsed = updateCommentRequestSchema.parse(request.body);
        const item = await updateIssueComment(
          deps.db,
          user.id,
          params.issueId,
          params.commentId,
          parsed,
        );
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/issues/:issueId/activity",
    {
      schema: {
        tags: ["Issues"],
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
          200: activityListJson,
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
        const parsed = activityListQuerySchema.parse(request.query);
        const result = await listIssueActivity(
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
}
