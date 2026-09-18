import { notificationListQuerySchema } from "@replaybug/contracts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired } from "../errors.js";
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../services/notifications.js";

export interface NotificationRouteDeps {
  db: Database;
  auth: Auth;
}

const notificationJson = {
  type: "object",
  required: [
    "id",
    "type",
    "title",
    "body",
    "projectId",
    "issueId",
    "readAt",
    "createdAt",
  ],
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    projectId: { type: ["string", "null"] },
    issueId: { type: ["string", "null"] },
    readAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
} as const;

const notificationListJson = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: notificationJson },
    nextCursor: { type: "string" },
  },
} as const;

const unreadCountJson = {
  type: "object",
  required: ["unreadCount"],
  properties: { unreadCount: { type: "number" } },
} as const;

const markedJson = {
  type: "object",
  required: ["marked"],
  properties: { marked: { type: "number" } },
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
 * Own-user in-app notifications: list, unread count, mark read, mark all
 * read. No email/push. Tags: Notifications.
 */
export async function registerNotificationRoutes(
  app: AppInstance,
  deps: NotificationRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/notifications",
    {
      schema: {
        tags: ["Notifications"],
        querystring: {
          type: "object",
          properties: {
            unreadOnly: { type: "string" },
            limit: { type: "string" },
            cursor: { type: "string" },
          },
        },
        response: {
          200: notificationListJson,
          400: errorJson,
          401: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const parsed = notificationListQuerySchema.parse(request.query);
        const result = await listNotifications(deps.db, user.id, parsed);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/notifications/unread-count",
    {
      schema: {
        tags: ["Notifications"],
        response: { 200: unreadCountJson, 401: errorJson },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const result = await getUnreadCount(deps.db, user.id);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.patch(
    "/api/v1/notifications/:id/read",
    {
      schema: {
        tags: ["Notifications"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: notificationJson,
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
        const item = await markNotificationRead(deps.db, user.id, params.id);
        await reply.send(item);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/notifications/read-all",
    {
      schema: {
        tags: ["Notifications"],
        response: { 200: markedJson, 401: errorJson },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, deps.auth);
        if (user === null) {
          throw authRequired();
        }
        const result = await markAllNotificationsRead(deps.db, user.id);
        await reply.send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
