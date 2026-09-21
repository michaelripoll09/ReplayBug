import { OccurrenceRepo, SessionRepo, type Database } from "@replaybug/db";
import type {
  SessionEvent,
  SessionEventsQuery,
  SessionListQuery,
  TelemetrySession,
  TimelineContextQuery,
} from "@replaybug/contracts";
import { notFound, validationError } from "../errors.js";
import { projectWithAccess } from "./issues.js";
import { toSessionDto, toSessionEventDto } from "./dto.js";

/**
 * Project session list (session:read). Cross-workspace projects stay
 * NOT_FOUND; host identifiers never reach the DTO.
 */
export async function listSessions(
  db: Database,
  userId: string,
  projectId: string,
  query: SessionListQuery,
): Promise<{ items: TelemetrySession[]; nextCursor?: string }> {
  const { project } = await projectWithAccess(
    db,
    userId,
    projectId,
    "session:read",
  );
  let cursor: SessionRepo.SessionCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = SessionRepo.decodeSessionCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await SessionRepo.listSessions(db, {
    projectId: project.id,
    ...(query.environment !== undefined
      ? { environment: query.environment }
      : {}),
    ...(query.release !== undefined ? { release: query.release } : {}),
    ...(query.since !== undefined ? { since: new Date(query.since) } : {}),
    ...(query.until !== undefined ? { until: new Date(query.until) } : {}),
    ...(query.hasErrors === true ? { hasErrors: true as const } : {}),
    order: query.order,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return result.nextCursor === null
    ? { items: result.rows.map(toSessionDto) }
    : { items: result.rows.map(toSessionDto), nextCursor: result.nextCursor };
}

/** Session detail (session:read, anti-enumeration). */
export async function getSessionById(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<TelemetrySession> {
  const session = await SessionRepo.findSessionById(db, sessionId);
  if (session === undefined) {
    throw notFound("Session");
  }
  await projectWithAccess(db, userId, session.projectId, "session:read");
  return toSessionDto(session);
}

async function sessionWithAccess(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<{
  session: NonNullable<Awaited<ReturnType<typeof SessionRepo.findSessionById>>>;
}> {
  const session = await SessionRepo.findSessionById(db, sessionId);
  if (session === undefined) {
    throw notFound("Session");
  }
  await projectWithAccess(db, userId, session.projectId, "session:read");
  return { session };
}

/**
 * Session timeline in sequence order with bounded keyset pagination.
 * Entries carry per-type safe summaries, never full payloads.
 */
export async function listSessionEvents(
  db: Database,
  userId: string,
  sessionId: string,
  query: SessionEventsQuery,
): Promise<{ items: SessionEvent[]; nextCursor?: string }> {
  const { session } = await sessionWithAccess(db, userId, sessionId);
  let cursor: SessionRepo.EventCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = SessionRepo.decodeEventCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await SessionRepo.listSessionEvents(db, {
    sessionId: session.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return result.nextCursor === null
    ? { items: result.rows.map(toSessionEventDto) }
    : {
        items: result.rows.map(toSessionEventDto),
        nextCursor: result.nextCursor,
      };
}

/**
 * Sequence-based context window around one occurrence: the anchor plus up
 * to `before` earlier and `after` later session events (defaults 20/5,
 * bounded by the query contract). Powers the embedded issue-detail
 * timeline and the full session view without loading whole sessions.
 */
export async function getTimelineContext(
  db: Database,
  userId: string,
  eventId: string,
  query: TimelineContextQuery,
): Promise<{
  sessionId: string;
  anchor: SessionEvent;
  before: SessionEvent[];
  after: SessionEvent[];
}> {
  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined) {
    throw notFound("Event");
  }
  const { session } = await sessionWithAccess(
    db,
    userId,
    event.telemetrySessionId,
  );
  const window = await SessionRepo.getTimelineContext(db, {
    sessionId: session.id,
    anchorSequence: event.sequenceNumber,
    anchorId: event.id,
    before: query.before,
    after: query.after,
  });
  return {
    sessionId: session.id,
    anchor: toSessionEventDto(event),
    before: window.before.map(toSessionEventDto),
    after: window.after.map(toSessionEventDto),
  };
}
