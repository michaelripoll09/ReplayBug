import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { events, issueTagAssignments, issueTags, issues } from "../schema.js";
import type { DbOrTx } from "./db-types.js";
import type { IssueRow } from "./issues.js";

export type IssueListSort =
  "last_seen" | "first_seen" | "occurrence_count" | "affected_sessions";
export type IssueListOrder = "asc" | "desc";

export interface IssueListCursor {
  value: string | number;
  id: string;
}

export interface ListIssuesInput {
  projectId: string;
  status?: "open" | "investigating" | "resolved" | "ignored";
  environment?: string;
  release?: string;
  type?: string;
  assigneeId?: string;
  unassigned?: boolean;
  /** Project-local tag slug. */
  tag?: string;
  since?: Date;
  until?: Date;
  /** Free-text query over title/normalized message. */
  q?: string;
  sort: IssueListSort;
  order: IssueListOrder;
  /** Bounded page size (1..100); one extra row is read for nextCursor. */
  limit: number;
  cursor?: IssueListCursor;
}

export interface ListIssuesResult {
  rows: IssueRow[];
  nextCursor: string | null;
}

const CURSOR_VERSION = 1;

/**
 * Opaque keyset cursor: base64url of {v:1, s:sort, o:order, value, id}.
 * Sort+order ride along so a cursor from another ordering is rejected
 * instead of silently returning wrong pages.
 */
export function encodeIssueCursor(
  sort: IssueListSort,
  order: IssueListOrder,
  value: string | number,
  id: string,
): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, s: sort, o: order, value, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeIssueCursor(
  sort: IssueListSort,
  order: IssueListOrder,
  raw: string,
): IssueListCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== CURSOR_VERSION ||
      record["s"] !== sort ||
      record["o"] !== order ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    const value = record["value"];
    if (sort === "occurrence_count" || sort === "affected_sessions") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        return null;
      }
      return { value, id: record["id"] };
    }
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return null;
    }
    return { value, id: record["id"] };
  } catch {
    return null;
  }
}

function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function sortColumn(sort: IssueListSort) {
  switch (sort) {
    case "first_seen":
      return issues.firstSeenAt;
    case "occurrence_count":
      return issues.occurrenceCount;
    case "affected_sessions":
      return issues.affectedSessionCount;
    case "last_seen":
    default:
      return issues.lastSeenAt;
  }
}

/**
 * Keyset condition for "rows after the cursor" under ORDER BY
 * <sort> <order>, id ASC. The id tiebreak keeps pagination stable when
 * many issues share the same sort value (no duplicates, no skips).
 */
function keysetCondition(
  sort: IssueListSort,
  order: IssueListOrder,
  cursor: IssueListCursor,
): SQL {
  const column = sortColumn(sort);
  const primary = order === "desc" ? sql`<` : sql`>`;
  return sql`(${column} ${primary} ${cursor.value} OR (${column} = ${cursor.value} AND ${issues.id} > ${cursor.id}))`;
}

/**
 * Project-scoped issue list with filters, stable keyset pagination and no
 * N+1 (callers batch tags/assignees separately via `listTagsForIssues` and
 * `findUsersByIds`). Environment filtering uses EXISTS on events because
 * the environment of an occurrence lives on the event, not the aggregate.
 */
export async function listIssues(
  db: DbOrTx,
  input: ListIssuesInput,
): Promise<ListIssuesResult> {
  const conditions: SQL[] = [eq(issues.projectId, input.projectId)];

  if (input.status !== undefined) {
    conditions.push(eq(issues.status, input.status));
  }
  if (input.type !== undefined) {
    conditions.push(eq(issues.type, input.type));
  }
  if (input.release !== undefined) {
    conditions.push(eq(issues.lastRelease, input.release));
  }
  if (input.assigneeId !== undefined) {
    conditions.push(eq(issues.assignedToUserId, input.assigneeId));
  } else if (input.unassigned === true) {
    conditions.push(isNull(issues.assignedToUserId));
  }
  if (input.since !== undefined) {
    conditions.push(gte(issues.lastSeenAt, input.since));
  }
  if (input.until !== undefined) {
    conditions.push(lte(issues.lastSeenAt, input.until));
  }
  if (input.environment !== undefined) {
    const environment = input.environment;
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(events)
          .where(
            and(
              eq(events.issueId, issues.id),
              eq(events.environment, environment),
            ),
          ),
      ),
    );
  }
  if (input.tag !== undefined) {
    const slug = input.tag;
    const projectId = input.projectId;
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(issueTagAssignments)
          .innerJoin(issueTags, eq(issueTagAssignments.tagId, issueTags.id))
          .where(
            and(
              eq(issueTagAssignments.issueId, issues.id),
              eq(issueTags.projectId, projectId),
              eq(issueTags.slug, slug),
            ),
          ),
      ),
    );
  }
  if (input.q !== undefined && input.q.trim() !== "") {
    const q = input.q.trim();
    // Trigram similarity (typo-tolerant, explicit threshold so results do
    // not depend on the server's pg_trgm.similarity_threshold setting) plus
    // case-insensitive substring for exact matches (`%` is case-sensitive),
    // plus project-agnostic tag-name matching (tags are already scoped to
    // the issue through the assignment join).
    const pattern = `%${escapeLikePattern(q)}%`;
    conditions.push(sql`(
      similarity(${issues.title}, ${q}) > 0.15
      OR similarity(${issues.normalizedMessage}, ${q}) > 0.15
      OR ${issues.title} ILIKE ${pattern} ESCAPE '\\'
      OR ${issues.normalizedMessage} ILIKE ${pattern} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM ${issueTagAssignments} AS ta
        INNER JOIN ${issueTags} AS t ON t.id = ta.tag_id
        WHERE ta.issue_id = ${issues.id}
          AND (
            t.name ILIKE ${pattern} ESCAPE '\\'
            OR t.slug ILIKE ${pattern} ESCAPE '\\'
            OR similarity(t.name, ${q}) > 0.15
          )
      )
    )`);
  }
  if (input.cursor !== undefined) {
    conditions.push(keysetCondition(input.sort, input.order, input.cursor));
  }

  const column = sortColumn(input.sort);
  const ordering =
    input.order === "desc"
      ? [desc(column), asc(issues.id)]
      : [asc(column), asc(issues.id)];

  const rows = await db
    .select()
    .from(issues)
    .where(and(...conditions))
    .orderBy(...ordering)
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const rawValue =
        input.sort === "occurrence_count"
          ? last.occurrenceCount
          : input.sort === "affected_sessions"
            ? last.affectedSessionCount
            : input.sort === "first_seen"
              ? last.firstSeenAt.toISOString()
              : last.lastSeenAt.toISOString();
      nextCursor = encodeIssueCursor(
        input.sort,
        input.order,
        rawValue,
        last.id,
      );
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}
