import { and, eq, inArray } from "drizzle-orm";
import { issueTagAssignments, issueTags } from "../schema.js";
import { normalizeTagSlug } from "../domain/tag-slug.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type IssueTagRow = typeof issueTags.$inferSelect;
export type IssueTagAssignmentRow = typeof issueTagAssignments.$inferSelect;

export interface TagWithAssignment {
  tag: IssueTagRow;
  assignedAt: Date;
}

export { normalizeTagSlug };

/**
 * Finds a project-local tag by its deterministic slug.
 */
export async function findTagBySlug(
  db: DbOrTx,
  projectId: string,
  slug: string,
): Promise<IssueTagRow | undefined> {
  const rows = await db
    .select()
    .from(issueTags)
    .where(and(eq(issueTags.projectId, projectId), eq(issueTags.slug, slug)))
    .limit(1);
  return rows[0];
}

/**
 * Inserts a tag unless the same (project, slug) already exists.
 * Returns the inserted row, or undefined when a concurrent caller won the
 * race — lock/read the committed row via `findTagBySlug` in that case.
 */
export async function insertTagIfAbsent(
  tx: DbTransaction,
  input: { projectId: string; name: string },
): Promise<IssueTagRow | undefined> {
  const slug = normalizeTagSlug(input.name);
  const rows = await tx
    .insert(issueTags)
    .values({ projectId: input.projectId, name: input.name.trim(), slug })
    .onConflictDoNothing({
      target: [issueTags.projectId, issueTags.slug],
    })
    .returning();
  return rows[0];
}

/**
 * Finds a tag by id (no project scoping; callers enforce project locality).
 */
export async function findTagById(
  db: DbOrTx,
  tagId: string,
): Promise<IssueTagRow | undefined> {
  const rows = await db
    .select()
    .from(issueTags)
    .where(eq(issueTags.id, tagId))
    .limit(1);
  return rows[0];
}

/**
 * Lists all tags of a project, alphabetical by name for stable UI.
 */
export async function listTagsByProject(
  db: DbOrTx,
  projectId: string,
): Promise<IssueTagRow[]> {
  return db
    .select()
    .from(issueTags)
    .where(eq(issueTags.projectId, projectId))
    .orderBy(issueTags.name);
}

/**
 * Assigns a tag to an issue. Idempotent: re-assigning is a no-op that
 * returns false, a new assignment returns true.
 */
export async function assignTagToIssue(
  tx: DbTransaction,
  issueId: string,
  tagId: string,
): Promise<boolean> {
  const rows = await tx
    .insert(issueTagAssignments)
    .values({ issueId, tagId })
    .onConflictDoNothing({
      target: [issueTagAssignments.issueId, issueTagAssignments.tagId],
    })
    .returning();
  return rows.length > 0;
}

/**
 * Removes a tag from an issue. Returns true when a row was removed.
 */
export async function unassignTagFromIssue(
  tx: DbTransaction,
  issueId: string,
  tagId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(issueTagAssignments)
    .where(
      and(
        eq(issueTagAssignments.issueId, issueId),
        eq(issueTagAssignments.tagId, tagId),
      ),
    )
    .returning();
  return rows.length > 0;
}

/**
 * Lists the tags assigned to one issue, alphabetical by name.
 */
export async function listTagsForIssue(
  db: DbOrTx,
  issueId: string,
): Promise<IssueTagRow[]> {
  return db
    .select({ tag: issueTags })
    .from(issueTagAssignments)
    .innerJoin(issueTags, eq(issueTagAssignments.tagId, issueTags.id))
    .where(eq(issueTagAssignments.issueId, issueId))
    .orderBy(issueTags.name)
    .then((rows) => rows.map((r) => r.tag));
}

/**
 * Batch tag lookup for issue lists: one query for many issues, so the
 * list endpoint never pays N+1 tag queries.
 */
export async function listTagsForIssues(
  db: DbOrTx,
  issueIds: readonly string[],
): Promise<Map<string, IssueTagRow[]>> {
  const result = new Map<string, IssueTagRow[]>();
  if (issueIds.length === 0) {
    return result;
  }
  for (const id of issueIds) {
    result.set(id, []);
  }
  const rows = await db
    .select({
      issueId: issueTagAssignments.issueId,
      tag: issueTags,
    })
    .from(issueTagAssignments)
    .innerJoin(issueTags, eq(issueTagAssignments.tagId, issueTags.id))
    .where(inArray(issueTagAssignments.issueId, [...issueIds]))
    .orderBy(issueTags.name);
  for (const row of rows) {
    result.get(row.issueId)?.push(row.tag);
  }
  return result;
}
