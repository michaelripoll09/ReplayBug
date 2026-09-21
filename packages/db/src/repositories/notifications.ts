import { and, asc, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { notifications } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * Notification types the schema accepts. Only `issue_regression` is produced
 * today; the rest mirror the master spec catalogue and are reserved for later
 * blocks. No email, push or external delivery is involved.
 */
export const NOTIFICATION_TYPES = [
  "issue_assigned",
  "issue_comment_mention",
  "issue_regression",
  "reproduction_failed",
  "ai_analysis_completed",
  "ai_analysis_failed",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface CreateNotificationInput {
  userId: string;
  workspaceId: string;
  projectId: string | null;
  issueId: string | null;
  type: NotificationType;
  title: string;
  body: string;
}

export async function insertNotification(
  tx: DbTransaction,
  input: CreateNotificationInput,
): Promise<NotificationRow | undefined> {
  const rows = await tx
    .insert(notifications)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      issueId: input.issueId,
      type: input.type,
      title: input.title,
      body: input.body,
      readAt: null,
    })
    .returning();
  return rows[0];
}

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

export interface ListNotificationsInput {
  userId: string;
  unreadOnly: boolean;
  limit: number;
  cursor?: NotificationCursor;
}

export interface ListNotificationsResult {
  rows: NotificationRow[];
  nextCursor: string | null;
}

const NOTIFICATION_CURSOR_VERSION = 1;

/** Opaque cursor over (created_at DESC, id ASC) — newest first. */
export function encodeNotificationCursor(
  createdAt: string,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: NOTIFICATION_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeNotificationCursor(
  raw: string,
): NotificationCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== NOTIFICATION_CURSOR_VERSION ||
      typeof record["createdAt"] !== "string" ||
      Number.isNaN(Date.parse(record["createdAt"])) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { createdAt: record["createdAt"], id: record["id"] };
  } catch {
    return null;
  }
}

/**
 * Own-user notification list, newest first, with stable keyset pagination.
 * Callers always scope by the authenticated user id — there is no
 * cross-user listing.
 */
export async function listNotifications(
  db: DbOrTx,
  input: ListNotificationsInput,
): Promise<ListNotificationsResult> {
  const conditions: SQL[] = [eq(notifications.userId, input.userId)];
  if (input.unreadOnly) {
    conditions.push(isNull(notifications.readAt));
  }
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${notifications.createdAt} < ${input.cursor.createdAt}
      OR (${notifications.createdAt} = ${input.cursor.createdAt}
          AND ${notifications.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), asc(notifications.id))
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const created =
        last.createdAt instanceof Date
          ? last.createdAt.toISOString()
          : new Date(last.createdAt).toISOString();
      nextCursor = encodeNotificationCursor(created, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}

/** Counts the caller's unread notifications. */
export async function countUnreadNotifications(
  db: DbOrTx,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows[0]?.value ?? 0;
}

/**
 * Marks one notification read. Ownership is enforced in the WHERE clause:
 * another user's id matches nothing (NOT_FOUND, never a leak). Setting an
 * already-read row is a successful no-op returning the row.
 */
export async function markNotificationRead(
  tx: DbTransaction,
  input: { id: string; userId: string },
): Promise<NotificationRow | undefined> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, input.id),
        eq(notifications.userId, input.userId),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Marks all of the caller's unread notifications read. Returns the count
 * of rows transitioned (already-read rows are untouched).
 */
export async function markAllNotificationsRead(
  tx: DbTransaction,
  userId: string,
): Promise<number> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
