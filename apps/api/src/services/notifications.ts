import { MembershipRepo, NotificationRepo, type Database } from "@replaybug/db";
import type {
  Notification,
  NotificationListQuery,
  WorkspaceRole,
} from "@replaybug/contracts";
import { notFound, validationError } from "../errors.js";
import { requireWorkspaceCapability } from "../authz/guards.js";
import { toNotificationDto } from "./dto.js";

/**
 * Own-user notifications (dashboard only, no email/push). Every function
 * scopes by the authenticated user id; there is deliberately no code path
 * that reads another user's notifications.
 *
 * The `notification:read-own` capability rides on any workspace membership
 * (viewer and up). Users keep their notifications only while their
 * workspace exists (FK cascade), so a memberless caller owns nothing:
 * reads return empty, writes 404.
 */
async function membershipForCap(
  db: Database,
  userId: string,
): Promise<{
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
} | null> {
  const all = await MembershipRepo.listMembershipsByUser(db, userId);
  const first = all[0];
  if (first === undefined) {
    return null;
  }
  return {
    workspaceId: first.workspaceId,
    userId: first.userId,
    role: first.role as WorkspaceRole,
  };
}
export async function listNotifications(
  db: Database,
  userId: string,
  query: NotificationListQuery,
): Promise<{ items: Notification[]; nextCursor?: string }> {
  const membership = await membershipForCap(db, userId);
  if (membership === null) {
    return { items: [] };
  }
  requireWorkspaceCapability(membership, "notification:read-own");
  let cursor: NotificationRepo.NotificationCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = NotificationRepo.decodeNotificationCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await NotificationRepo.listNotifications(db, {
    userId,
    unreadOnly: query.unreadOnly,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return result.nextCursor === null
    ? { items: result.rows.map(toNotificationDto) }
    : {
        items: result.rows.map(toNotificationDto),
        nextCursor: result.nextCursor,
      };
}

export async function getUnreadCount(
  db: Database,
  userId: string,
): Promise<{ unreadCount: number }> {
  const membership = await membershipForCap(db, userId);
  if (membership === null) {
    return { unreadCount: 0 };
  }
  requireWorkspaceCapability(membership, "notification:read-own");
  const unreadCount = await NotificationRepo.countUnreadNotifications(
    db,
    userId,
  );
  return { unreadCount };
}

/**
 * Marks one notification read. Ownership is enforced in the UPDATE's
 * WHERE clause: another user's id matches nothing → NOT_FOUND.
 */
export async function markNotificationRead(
  db: Database,
  userId: string,
  notificationId: string,
): Promise<Notification> {
  const membership = await membershipForCap(db, userId);
  if (membership === null) {
    throw notFound("Notification");
  }
  requireWorkspaceCapability(membership, "notification:read-own");
  const row = await db.transaction(async (tx) =>
    NotificationRepo.markNotificationRead(tx, {
      id: notificationId,
      userId,
    }),
  );
  if (row === undefined) {
    throw notFound("Notification");
  }
  return toNotificationDto(row);
}

/** Marks all of the caller's unread notifications read. */
export async function markAllNotificationsRead(
  db: Database,
  userId: string,
): Promise<{ marked: number }> {
  const membership = await membershipForCap(db, userId);
  if (membership === null) {
    return { marked: 0 };
  }
  requireWorkspaceCapability(membership, "notification:read-own");
  const marked = await db.transaction(async (tx) =>
    NotificationRepo.markAllNotificationsRead(tx, userId),
  );
  return { marked };
}
