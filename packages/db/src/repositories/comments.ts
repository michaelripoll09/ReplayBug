import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import { issueComments } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type IssueCommentRow = typeof issueComments.$inferSelect;

/** Maximum stored comment body length (chars); enforced by DB CHECK too. */
export const ISSUE_COMMENT_MAX_LENGTH = 10_000;

export interface CreateIssueCommentInput {
  issueId: string;
  authorUserId: string;
  bodyMarkdown: string;
}

/**
 * Inserts one comment. Callers validate non-empty/trimmed bodies and the
 * length bound before reaching the repository; the DB CHECK is the backstop.
 */
export async function insertIssueComment(
  tx: DbTransaction,
  input: CreateIssueCommentInput,
): Promise<IssueCommentRow | undefined> {
  const rows = await tx
    .insert(issueComments)
    .values({
      issueId: input.issueId,
      authorUserId: input.authorUserId,
      bodyMarkdown: input.bodyMarkdown,
    })
    .returning();
  return rows[0];
}

/**
 * Lists an issue's comments oldest-first with a hard bound so detail pages
 * never load unbounded histories.
 */
export async function listCommentsByIssue(
  db: DbOrTx,
  issueId: string,
  limit = 100,
): Promise<IssueCommentRow[]> {
  return db
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
    .limit(limit);
}

/** Reads one comment by id (no lock). */
export async function findCommentById(
  db: DbOrTx,
  commentId: string,
): Promise<IssueCommentRow | undefined> {
  const rows = await db
    .select()
    .from(issueComments)
    .where(eq(issueComments.id, commentId))
    .limit(1);
  return rows[0];
}

/**
 * Replaces a comment body and bumps updated_at. Only the author may edit
 * (enforced by the service layer, which knows the caller).
 */
export async function updateCommentBody(
  tx: DbTransaction,
  commentId: string,
  bodyMarkdown: string,
): Promise<IssueCommentRow | undefined> {
  const rows = await tx
    .update(issueComments)
    .set({ bodyMarkdown, updatedAt: new Date() })
    .where(eq(issueComments.id, commentId))
    .returning();
  return rows[0];
}

/**
 * Deletes a comment. Returns true when a row was removed.
 */
export async function deleteComment(
  tx: DbTransaction,
  commentId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(issueComments)
    .where(eq(issueComments.id, commentId))
    .returning({ id: issueComments.id });
  return rows.length > 0;
}

/** Counts comments of an issue (bounded pagination metadata). */
export async function countCommentsByIssue(
  db: DbOrTx,
  issueId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId));
  return rows[0]?.value ?? 0;
}

export interface CommentCursor {
  createdAt: string;
  id: string;
}

export interface ListCommentsInput {
  issueId: string;
  limit: number;
  cursor?: CommentCursor;
}

export interface ListCommentsResult {
  rows: IssueCommentRow[];
  nextCursor: string | null;
}

const COMMENT_CURSOR_VERSION = 1;

/** Opaque cursor over (created_at ASC, id ASC) — oldest comments first. */
export function encodeCommentCursor(createdAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: COMMENT_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCommentCursor(raw: string): CommentCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== COMMENT_CURSOR_VERSION ||
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
 * Issue comments oldest-first with stable keyset pagination. Bounded: the
 * caller caps `limit` (default 50, max 100 at the route layer).
 */
export async function listCommentsPaged(
  db: DbOrTx,
  input: ListCommentsInput,
): Promise<ListCommentsResult> {
  const conditions: SQL[] = [eq(issueComments.issueId, input.issueId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${issueComments.createdAt} > ${input.cursor.createdAt}
      OR (${issueComments.createdAt} = ${input.cursor.createdAt}
          AND ${issueComments.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(issueComments)
    .where(and(...conditions))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id))
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
      nextCursor = encodeCommentCursor(created, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}
