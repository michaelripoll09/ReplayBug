import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { events } from "../schema.js";
import type { DbOrTx } from "./db-types.js";
import type { EventRow } from "./telemetry.js";

export interface OccurrenceCursor {
  occurredAt: string;
  id: string;
}

export interface ListOccurrencesInput {
  issueId: string;
  limit: number;
  cursor?: OccurrenceCursor;
}

export interface ListOccurrencesResult {
  rows: EventRow[];
  nextCursor: string | null;
}

const CURSOR_VERSION = 1;

/** Opaque cursor over (occurred_at DESC, id ASC). */
export function encodeOccurrenceCursor(occurredAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, occurredAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeOccurrenceCursor(raw: string): OccurrenceCursor | null {
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
      typeof record["occurredAt"] !== "string" ||
      Number.isNaN(Date.parse(record["occurredAt"])) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { occurredAt: record["occurredAt"], id: record["id"] };
  } catch {
    return null;
  }
}

/** Reads one event by id (no lock). */
export async function findEventById(
  db: DbOrTx,
  eventId: string,
): Promise<EventRow | undefined> {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0];
}

/**
 * Issue occurrences newest-first with stable keyset pagination. Rows carry
 * the full stored record; the service maps them to the payload-free
 * occurrence DTO. Served by `events_issue_occurred_idx`.
 */
export async function listIssueOccurrences(
  db: DbOrTx,
  input: ListOccurrencesInput,
): Promise<ListOccurrencesResult> {
  const conditions: SQL[] = [eq(events.issueId, input.issueId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${events.occurredAt} < ${input.cursor.occurredAt}
      OR (${events.occurredAt} = ${input.cursor.occurredAt}
          AND ${events.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.occurredAt), asc(events.id))
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const occurred =
        last.occurredAt instanceof Date
          ? last.occurredAt.toISOString()
          : new Date(last.occurredAt).toISOString();
      nextCursor = encodeOccurrenceCursor(occurred, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}
