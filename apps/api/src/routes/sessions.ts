import {
  sessionEventsQuerySchema,
  sessionListQuerySchema,
  timelineContextQuerySchema,
} from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  getSessionById,
  getTimelineContext,
  listSessionEvents,
  listSessions,
} from "../services/sessions.js";

export interface SessionRouteDeps {
  db: Database;
  auth: Auth;
}

const telemetrySessionJson = {
  type: "object",
  required: [
    "id",
    "projectId",
    "environment",
    "release",
    "startedAt",
    "lastSeenAt",
    "initialUrl",
    "browserName",
    "browserVersion",
    "osName",
    "osVersion",
    "deviceType",
    "viewportWidth",
    "viewportHeight",
    "sdkVersion",
  ],
  properties: {
    id: { type: "string" },
    projectId: { type: "string" },
    environment: { type: "string" },
    release: { type: ["string", "null"] },
    startedAt: { type: "string" },
    lastSeenAt: { type: "string" },
    initialUrl: { type: "string" },
    browserName: { type: ["string", "null"] },
    browserVersion: { type: ["string", "null"] },
    osName: { type: ["string", "null"] },
    osVersion: { type: ["string", "null"] },
    deviceType: { type: ["string", "null"] },
    viewportWidth: { type: ["number", "null"] },
    viewportHeight: { type: ["number", "null"] },
    sdkVersion: { type: "string" },
  },
} as const;

const sessionListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: telemetrySessionJson },
    nextCursor: { type: "string" },
  },
} as const;

const sessionEventJson = {
  type: "object",
  required: [
    "id",
    "sequenceNumber",
    "eventType",
    "occurredAt",
    "receivedAt",
    "environment",
    "release",
    "pageUrl",
    "processingState",
    "summary",
  ],
  properties: {
    id: { type: "string" },
    sequenceNumber: { type: "number" },
    eventType: { type: "string" },
    occurredAt: { type: "string" },
    receivedAt: { type: "string" },
    environment: { type: "string" },
    release: { type: ["string", "null"] },
    pageUrl: { type: ["string", "null"] },
    processingState: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const sessionEventsListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: sessionEventJson },
    nextCursor: { type: "string" },
  },
} as const;

const timelineContextJson = {
  type: "object",
  required: ["sessionId", "anchor", "before", "after"],
  properties: {
    sessionId: { type: "string" },
    anchor: sessionEventJson,
    before: { type: "array", items: sessionEventJson },
    after: { type: "array", items: sessionEventJson },
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
 * Sessions + timeline context: project list, session detail, ordered
 * session events and sequence windows around an occurrence.
 * Tags: Sessions.
 */
export async function registerSessionRoutes(
  app: AppInstance,
  deps: SessionRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/sessions",
    {
      schema: {
        tags: ["Sessions"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            environment: { type: "string" },
            release: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            hasErrors: { type: "string" },
            order: { type: "string", enum: ["asc", "desc"] },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: {
          200: sessionListJson,
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
        const parsed = sessionListQuerySchema.parse(request.query);
        const result = await listSessions(
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
    "/api/v1/sessions/:sessionId",
    {
      schema: {
        tags: ["Sessions"],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        response: {
          200: telemetrySessionJson,
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
        const params = request.params as { sessionId: string };
        const item = await getSessionById(deps.db, user.id, params.sessionId);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/sessions/:sessionId/events",
    {
      schema: {
        tags: ["Sessions"],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: {
          200: sessionEventsListJson,
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
        const params = request.params as { sessionId: string };
        const parsed = sessionEventsQuerySchema.parse(request.query);
        const result = await listSessionEvents(
          deps.db,
          user.id,
          params.sessionId,
          parsed,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/events/:eventId/timeline-context",
    {
      schema: {
        tags: ["Sessions"],
        params: {
          type: "object",
          required: ["eventId"],
          properties: { eventId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            before: { type: "string" },
            after: { type: "string" },
          },
        },
        response: {
          200: timelineContextJson,
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
        const params = request.params as { eventId: string };
        const parsed = timelineContextQuerySchema.parse(request.query);
        const result = await getTimelineContext(
          deps.db,
          user.id,
          params.eventId,
          parsed,
        );
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
