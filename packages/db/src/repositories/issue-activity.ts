import { eq } from "drizzle-orm";
import { issueActivity } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type IssueActivityRow = typeof issueActivity.$inferSelect;

/**
 * Activity types the schema accepts. Only `created` and `regression_detected`
 * are produced today; the rest are reserved for later blocks.
 */
export const ISSUE_ACTIVITY_TYPES = [
  "created",
  "assigned",
  "unassigned",
  "status_changed",
  "comment_added",
  "regression_detected",
  "reproduction_generated",
  "ai_analysis_requested",
  "ai_analysis_completed",
  "ai_analysis_failed",
] as const;
export type IssueActivityType = (typeof ISSUE_ACTIVITY_TYPES)[number];

export interface CreateIssueActivityInput {
  issueId: string;
  actorUserId: string | null;
  type: IssueActivityType;
  metadataJson?: Record<string, unknown>;
}

/**
 * Appends one immutable activity row. Worker-generated rows carry a NULL
 * actor. Historical rows are never updated.
 */
export async function insertIssueActivity(
  tx: DbTransaction,
  input: CreateIssueActivityInput,
): Promise<IssueActivityRow | undefined> {
  const rows = await tx
    .insert(issueActivity)
    .values({
      issueId: input.issueId,
      actorUserId: input.actorUserId,
      type: input.type,
      metadataJson: input.metadataJson ?? {},
    })
    .returning();
  return rows[0];
}

/** Lists the activity timeline of an issue, oldest first. */
export async function listIssueActivity(
  db: DbOrTx,
  issueId: string,
): Promise<IssueActivityRow[]> {
  return db
    .select()
    .from(issueActivity)
    .where(eq(issueActivity.issueId, issueId))
    .orderBy(issueActivity.createdAt);
}
