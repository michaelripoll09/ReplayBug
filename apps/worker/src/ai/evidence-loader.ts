import {
  IssueRepo,
  OccurrenceRepo,
  SessionRepo,
  type Database,
  type TelemetryRepo,
} from "@replaybug/db";
import { eventSymbolicationSchema } from "@replaybug/contracts";
import {
  buildAiEvidence,
  type AiEvidenceMappedFrameInput,
  type AiEvidenceNetworkInput,
  type AiEvidenceRawFrameInput,
  type AiEvidenceTimelineInput,
  type BuiltAiEvidence,
} from "./evidence.js";

type EventRow = TelemetryRepo.EventRow;

const SESSION_PAGE_LIMIT = 200;
const MAX_COLLECTED_EVENTS = 1_000;
const MAX_STACK_FRAMES = 50;

/**
 * Raised when the persisted analysis evidence cannot be reconstructed:
 * the referenced event/issue is gone, the issue link is broken, or the
 * session timeline cannot be read. Deterministic — never retried.
 */
export class AiEvidenceLoadError extends Error {
  readonly code = "AI_EVIDENCE_UNAVAILABLE" as const;
  constructor(message = "AI analysis evidence is unavailable.") {
    super(message);
    this.name = "AiEvidenceLoadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      if (out.length >= max) break;
    }
  }
  return out;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function firstExceptionValue(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const values = payload["values"];
  if (!Array.isArray(values)) return undefined;
  const first = values[0];
  return isRecord(first) ? first : undefined;
}

/**
 * Bounded, allowlisted per-event summary. Only whitelisted fields are read;
 * raw payload bags, headers, cookies, and request bodies never enter the
 * bundle.
 */
function eventMessage(eventType: string, payload: unknown): string {
  const p = isRecord(payload) ? payload : {};
  switch (eventType) {
    case "exception": {
      const first = firstExceptionValue(payload);
      const type = first === undefined ? undefined : asString(first["type"]);
      const value = first === undefined ? undefined : asString(first["value"]);
      return [type, value]
        .filter((part) => part !== undefined && part !== "")
        .join(": ");
    }
    case "unhandled_rejection":
      return asString(p["reason"]) ?? "";
    case "console":
    case "console_error":
      return asStringArray(p["args"], 5).join(" ");
    case "network": {
      const method = asString(p["method"]);
      const url = asString(p["url"]);
      const status = p["status_code"];
      const statusText =
        typeof status === "number" && Number.isInteger(status)
          ? String(status)
          : "";
      return [method, url, statusText]
        .filter((part) => part !== undefined && part !== "")
        .join(" ");
    }
    case "navigation": {
      const to = asString(p["to_url"]);
      return to === undefined || to === "" ? "" : `navigate to ${to}`;
    }
    case "click": {
      const name =
        asString(p["accessible_name"]) ?? asString(p["element_tag"]) ?? "";
      const route = asString(p["route"]);
      return [name, route].filter((part) => part !== "").join(" @ ");
    }
    case "input":
      return asString(p["input_name"]) ?? asString(p["input_id"]) ?? "";
    case "message":
    case "custom_breadcrumb":
      return asString(p["message"]) ?? "";
    case "sdk":
      return asString(p["event"]) ?? "";
    default:
      return "";
  }
}

function payloadFrames(payload: unknown): AiEvidenceRawFrameInput[] {
  if (!isRecord(payload)) return [];
  const values = payload["values"];
  if (!Array.isArray(values)) return [];
  const out: AiEvidenceRawFrameInput[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const stacktrace = value["stacktrace"];
    if (!isRecord(stacktrace)) continue;
    const frames = stacktrace["frames"];
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!isRecord(frame)) continue;
      out.push({
        filename: asString(frame["filename"]) ?? "",
        function: asString(frame["function"]) ?? null,
        line: asInteger(frame["lineno"]),
        column: asInteger(frame["colno"]),
      });
      if (out.length >= MAX_STACK_FRAMES) return out;
    }
  }
  return out;
}

function networkStatus(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const status = payload["status_code"];
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function toNetworkInput(row: EventRow): AiEvidenceNetworkInput | null {
  const payload = row.payloadJson;
  const status = networkStatus(payload);
  if (status === null || status < 400) return null;
  const p = isRecord(payload) ? payload : {};
  const method = asString(p["method"]);
  const url = asString(p["url"]);
  if (method === undefined || url === undefined) return null;
  return {
    id: row.id,
    sessionId: row.telemetrySessionId,
    occurredAt: toIso(row.occurredAt),
    method,
    path: url,
    status,
  };
}

async function collectSessionTimeline(
  db: Database,
  sessionId: string,
  anchorSequence: number,
): Promise<EventRow[]> {
  const collected: EventRow[] = [];
  let cursor: SessionRepo.EventCursor | undefined = undefined;
  for (;;) {
    const page = await SessionRepo.listSessionEvents(db, {
      sessionId,
      limit: SESSION_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    let stop = false;
    for (const row of page.rows) {
      if (row.sequenceNumber > anchorSequence) {
        stop = true;
        break;
      }
      collected.push(row);
      if (collected.length >= MAX_COLLECTED_EVENTS) {
        stop = true;
        break;
      }
    }
    if (stop || page.nextCursor === null) {
      break;
    }
    const decoded = SessionRepo.decodeEventCursor(page.nextCursor);
    if (decoded === null) {
      break;
    }
    cursor = decoded;
  }
  return collected;
}

/**
 * Loads and builds the sanitized, bounded AI evidence bundle for one
 * analysis's selected occurrence.
 *
 * Selected-occurrence semantics match issue detail and reproduction
 * generation: the anchor event is the analysis's event, the timeline is the
 * same telemetry session at-or-before the anchor, and the stack prefers the
 * symbolicated view when the persisted enrichment actually mapped frames.
 *
 * Reads only whitelisted fields through existing repositories. Throws
 * `AiEvidenceLoadError` for deterministic evidence problems; the caller
 * maps that to a non-retryable failure.
 */
export async function loadAiEvidence(
  db: Database,
  eventId: string,
): Promise<BuiltAiEvidence> {
  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined || event.issueId === null) {
    throw new AiEvidenceLoadError();
  }
  const issue = await IssueRepo.findIssueById(db, event.issueId);
  if (issue === undefined || issue.projectId !== event.projectId) {
    throw new AiEvidenceLoadError();
  }

  const timelineRows = await collectSessionTimeline(
    db,
    event.telemetrySessionId,
    event.sequenceNumber,
  );

  const symbolication = eventSymbolicationSchema.safeParse(
    event.symbolicationJson,
  );
  let rawStack: AiEvidenceRawFrameInput[] = [];
  let mappedStack: AiEvidenceMappedFrameInput[] = [];
  if (symbolication.success) {
    rawStack = symbolication.data.rawFrames
      .slice(0, MAX_STACK_FRAMES)
      .map((frame) => ({
        filename: frame.filename,
        function: frame.function,
        line: frame.lineno,
        column: frame.colno,
      }));
    if (
      (symbolication.data.status === "mapped" ||
        symbolication.data.status === "partially_mapped") &&
      symbolication.data.mappedFrames.length > 0
    ) {
      mappedStack = symbolication.data.mappedFrames
        .slice(0, MAX_STACK_FRAMES)
        .map((frame) => ({
          source: frame.source,
          name: frame.name,
          line: frame.line,
          column: frame.column,
        }));
    }
  }
  if (rawStack.length === 0 && event.eventType === "exception") {
    rawStack = payloadFrames(event.payloadJson);
  }

  const timeline: AiEvidenceTimelineInput[] = timelineRows.map((row) => ({
    id: row.id,
    sessionId: row.telemetrySessionId,
    occurredAt: toIso(row.occurredAt),
    kind: row.eventType,
    message: eventMessage(row.eventType, row.payloadJson),
  }));
  const network: AiEvidenceNetworkInput[] = [];
  for (const row of timelineRows) {
    if (row.eventType !== "network") continue;
    const entry = toNetworkInput(row);
    if (entry !== null) network.push(entry);
  }

  const exceptionType =
    event.eventType === "exception"
      ? (asString(firstExceptionValue(event.payloadJson)?.["type"]) ?? null)
      : null;

  return buildAiEvidence({
    issue: {
      normalizedMessage: issue.normalizedMessage,
      type: issue.type,
      severity: issue.severity,
      exceptionType,
    },
    selectedEvent: {
      id: event.id,
      sessionId: event.telemetrySessionId,
      occurredAt: toIso(event.occurredAt),
      receivedAt: toIso(event.receivedAt),
      environment: event.environment,
      release: event.release,
    },
    mappedStack,
    rawStack,
    timeline,
    network,
  });
}
