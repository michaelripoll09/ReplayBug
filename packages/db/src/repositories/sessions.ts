import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { events, telemetrySessions } from "../schema.js";
import type { DbOrTx } from "./db-types.js";
import type { TelemetrySessionRow } from "./telemetry.js";
import type { EventRow } from "./telemetry.js";

export interface SessionCursor {
  lastSeen: string;
  id: string;
}

export interface ListSessionsInput {
  projectId: string;
  environment?: string;
  release?: string;
  since?: Date;
  until?: Date;
  hasErrors?: boolean;
  order: "asc" | "desc";
  limit: number;
  cursor?: SessionCursor;
}

export interface ListSessionsResult {
  rows: TelemetrySessionRow[];
  nextCursor: string | null;
}

export interface EventCursor {
  sequence: number;
  id: string;
}

export interface ListSessionEventsInput {
  sessionId: string;
  limit: number;
  cursor?: EventCursor;
}

export interface ListSessionEventsResult {
  rows: EventRow[];
  nextCursor: string | null;
}

const SESSION_CURSOR_VERSION = 1;
const EVENT_CURSOR_VERSION = 1;

/** Opaque cursor over (last_seen_at <order>, id ASC). */
export function encodeSessionCursor(lastSeen: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: SESSION_CURSOR_VERSION, lastSeen, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeSessionCursor(raw: string): SessionCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== SESSION_CURSOR_VERSION ||
      typeof record["lastSeen"] !== "string" ||
      Number.isNaN(Date.parse(record["lastSeen"])) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { lastSeen: record["lastSeen"], id: record["id"] };
  } catch {
    return null;
  }
}

/** Opaque cursor over (sequence_number ASC, id ASC). */
export function encodeEventCursor(sequence: number, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: EVENT_CURSOR_VERSION, sequence, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeEventCursor(raw: string): EventCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== EVENT_CURSOR_VERSION ||
      typeof record["sequence"] !== "number" ||
      !Number.isInteger(record["sequence"]) ||
      typeof record["id"] !== "string"
    ) {
      return null;
    }
    return { sequence: record["sequence"], id: record["id"] };
  } catch {
    return null;
  }
}

/** Reads one telemetry session by id (no lock). */
export async function findSessionById(
  db: DbOrTx,
  sessionId: string,
): Promise<TelemetrySessionRow | undefined> {
  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(eq(telemetrySessions.id, sessionId))
    .limit(1);
  return rows[0];
}

/**
 * Project-scoped session list, newest activity first by default, with
 * stable keyset pagination. `hasErrors` matches sessions linked to at
 * least one grouped error occurrence (EXISTS on events with issue_id).
 */
export async function listSessions(
  db: DbOrTx,
  input: ListSessionsInput,
): Promise<ListSessionsResult> {
  const conditions: SQL[] = [eq(telemetrySessions.projectId, input.projectId)];
  if (input.environment !== undefined) {
    conditions.push(eq(telemetrySessions.environment, input.environment));
  }
  if (input.release !== undefined) {
    conditions.push(eq(telemetrySessions.release, input.release));
  }
  if (input.since !== undefined) {
    conditions.push(gte(telemetrySessions.lastSeenAt, input.since));
  }
  if (input.until !== undefined) {
    conditions.push(lte(telemetrySessions.lastSeenAt, input.until));
  }
  if (input.hasErrors === true) {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(events)
          .where(
            and(
              eq(events.telemetrySessionId, telemetrySessions.id),
              sql`${events.issueId} IS NOT NULL`,
            ),
          ),
      ),
    );
  }
  if (input.cursor !== undefined) {
    const primary =
      input.order === "desc"
        ? sql`${telemetrySessions.lastSeenAt} < ${input.cursor.lastSeen}`
        : sql`${telemetrySessions.lastSeenAt} > ${input.cursor.lastSeen}`;
    conditions.push(sql`(
      ${primary}
      OR (${telemetrySessions.lastSeenAt} = ${input.cursor.lastSeen}
          AND ${telemetrySessions.id} > ${input.cursor.id})
    )`);
  }

  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(and(...conditions))
    .orderBy(
      input.order === "desc"
        ? desc(telemetrySessions.lastSeenAt)
        : asc(telemetrySessions.lastSeenAt),
      asc(telemetrySessions.id),
    )
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      const seen =
        last.lastSeenAt instanceof Date
          ? last.lastSeenAt.toISOString()
          : new Date(last.lastSeenAt).toISOString();
      nextCursor = encodeSessionCursor(seen, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}

/**
 * Session timeline in sequence order (ASC) with id tiebreak and keyset
 * pagination. Bounded: the caller caps `limit` (default 100, max 200 at
 * the route layer).
 */
export async function listSessionEvents(
  db: DbOrTx,
  input: ListSessionEventsInput,
): Promise<ListSessionEventsResult> {
  const conditions: SQL[] = [eq(events.telemetrySessionId, input.sessionId)];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${events.sequenceNumber} > ${input.cursor.sequence}
      OR (${events.sequenceNumber} = ${input.cursor.sequence}
          AND ${events.id} > ${input.cursor.id})
    )`);
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.sequenceNumber), asc(events.id))
    .limit(input.limit + 1);

  let nextCursor: string | null = null;
  let page = rows;
  if (rows.length > input.limit) {
    const last = rows[input.limit - 1];
    if (last !== undefined) {
      nextCursor = encodeEventCursor(last.sequenceNumber, last.id);
    }
    page = rows.slice(0, input.limit);
  }
  return { rows: page, nextCursor };
}

export interface TimelineContext {
  before: EventRow[];
  anchor: EventRow;
  after: EventRow[];
}

/**
 * Sequence-based window around one anchor event: up to `before` earlier
 * events (returned oldest-first) plus up to `after` later events. Same
 * (sequence, id) ordering as the timeline, so the window splices into a
 * paged timeline without duplicates or gaps.
 */
export async function getTimelineContext(
  db: DbOrTx,
  input: {
    sessionId: string;
    anchorSequence: number;
    anchorId: string;
    before: number;
    after: number;
  },
): Promise<{ before: EventRow[]; after: EventRow[] }> {
  const earlier =
    input.before > 0
      ? await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.telemetrySessionId, input.sessionId),
              sql`(
              ${events.sequenceNumber} < ${input.anchorSequence}
              OR (${events.sequenceNumber} = ${input.anchorSequence}
                  AND ${events.id} < ${input.anchorId})
            )`,
            ),
          )
          .orderBy(desc(events.sequenceNumber), desc(events.id))
          .limit(input.before)
      : [];
  const later =
    input.after > 0
      ? await db
          .select()
          .from(events)
          .where(
            and(
              eq(events.telemetrySessionId, input.sessionId),
              sql`(
              ${events.sequenceNumber} > ${input.anchorSequence}
              OR (${events.sequenceNumber} = ${input.anchorSequence}
                  AND ${events.id} > ${input.anchorId})
            )`,
            ),
          )
          .orderBy(asc(events.sequenceNumber), asc(events.id))
          .limit(input.after)
      : [];
  return { before: [...earlier].reverse(), after: later };
}
