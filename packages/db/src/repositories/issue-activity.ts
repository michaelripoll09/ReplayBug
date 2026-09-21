import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
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

export interface ActivityCursor {
  createdAt: string;
  id: string;
}

export interface ListActivityInput {
  issueId: string;
  limit: number;
  cursor?: ActivityCursor;
}

export interface ListActivityResult {
  rows: IssueActivityRow[];
  nextCursor: string | null;
}

const ACTIVITY_CURSOR_VERSION = 1;

/** Opaque cursor over (created_at DESC, id ASC) — newest entries first. */
export function encodeActivityCursor(createdAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: ACTIVITY_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeActivityCursor(raw: string): ActivityCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== ACTIVITY_CURSOR_VERSION ||
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
 * Issue activity newest-first with stable keyset pagination. Bounded: the
 * caller caps `limit` (default 50, max 100 at the route layer).
 */
export async function listIssueActivityPaged(
  db: DbOrTx,
  input: ListActivityInput,
): Promise<ListActivityResult> {
  const conditions: SQL[] = [eq(issueActivity.issueId, input.issueId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${issueActivity.createdAt} < ${input.cursor.createdAt}
      OR (${issueActivity.createdAt} = ${input.cursor.createdAt}
          AND ${issueActivity.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(issueActivity)
    .where(and(...conditions))
    .orderBy(desc(issueActivity.createdAt), asc(issueActivity.id))
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
      nextCursor = encodeActivityCursor(created, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}
