import { notifications } from "../schema.js";
import type { DbTransaction } from "./db-types.js";

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
