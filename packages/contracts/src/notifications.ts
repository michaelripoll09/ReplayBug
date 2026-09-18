import { z } from "zod";

/**
 * Block 6 in-app notification DTOs. No email/push: dashboard only.
 * List endpoints always scope to the authenticated user server-side.
 */

export const notificationTypeSchema = z.enum([
  "issue_assigned",
  "issue_comment_mention",
  "issue_regression",
  "reproduction_failed",
  "ai_analysis_completed",
  "ai_analysis_failed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  projectId: z.string().uuid().nullable(),
  issueId: z.string().uuid().nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
