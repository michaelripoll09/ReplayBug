import {
  eventSymbolicationSchema,
  workspaceAuditActionSchema,
} from "@replaybug/contracts";
import type {
  EventDetail,
  EventDiagnostic,
  EventSymbolication,
  IssueActivity,
  IssueComment,
  IssueSummary,
  IssueTag,
  IssueTagSummary,
  Notification,
  Occurrence,
  SessionEvent,
  TelemetrySession,
  Project,
  ProjectEnvironment,
  ProjectKeyMeta,
  ProjectOrigin,
  UserSummary,
  Workspace,
  WorkspaceWithRole,
  WorkspaceRole,
  WorkspaceMember,
  WorkspaceInvitation,
  WorkspaceAuditEvent,
  WorkspaceInvitationStatus,
} from "@replaybug/contracts";
import { AuditRepo } from "@replaybug/db";
import type {
  InvitationRepo,
  EnvironmentRepo,
  IssueActivityRepo,
  IssueCommentRepo,
  IssueRepo,
  MembershipRepo,
  NotificationRepo,
  OriginRepo,
  ProjectKeyRepo,
  ProjectRepo,
  TagRepo,
  TelemetryRepo,
  UserRepo,
  WorkspaceRepo,
} from "@replaybug/db";
import type { AiAnalysisRepo } from "@replaybug/db";

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function toWorkspaceDto(row: WorkspaceRepo.WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toWorkspaceWithRoleDto(
  row: WorkspaceRepo.WorkspaceRow,
  role: WorkspaceRole,
): WorkspaceWithRole {
  return { ...toWorkspaceDto(row), role };
}

export function getWorkspaceInvitationStatus(
  row: Pick<
    InvitationRepo.InvitationRow,
    "expiresAt" | "acceptedAt" | "revokedAt"
  >,
  now = new Date(),
): WorkspaceInvitationStatus {
  if (row.acceptedAt !== null) {
    return "accepted";
  }
  // An explicit revoke remains revoked after the original expiry. Automatic
  // retirement records revoked_at at or after expiry, so it remains visibly
  // expired while still releasing the partial pending-email index.
  if (
    row.revokedAt !== null &&
    row.revokedAt.getTime() < row.expiresAt.getTime()
  ) {
    return "revoked";
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (row.revokedAt !== null) {
    return "revoked";
  }
  return "pending";
}

export function toWorkspaceInvitationDto(
  row: InvitationRepo.InvitationMetadataRow,
  now = new Date(),
): WorkspaceInvitation {
  const role = row.role;
  if (role !== "admin" && role !== "member" && role !== "viewer") {
    throw new Error("Invalid persisted invitation role");
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role,
    tokenPrefix: row.tokenPrefix,
    status: getWorkspaceInvitationStatus(row, now),
    expiresAt: iso(row.expiresAt),
    acceptedAt: row.acceptedAt === null ? null : iso(row.acceptedAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt),
  };
}

export function toProjectDto(row: ProjectRepo.ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    timezone: row.timezone,
    retentionDays: row.retentionDays,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toEnvironmentDto(
  row: EnvironmentRepo.EnvironmentRow,
): ProjectEnvironment {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    baseUrl: row.baseUrl,
    isDefault: row.isDefault,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toOriginDto(row: OriginRepo.OriginRow): ProjectOrigin {
  return {
    id: row.id,
    projectId: row.projectId,
    origin: row.origin,
    isEnabled: row.isEnabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toKeyMetaDto(
  row: ProjectKeyRepo.ProjectKeyRow,
): ProjectKeyMeta {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind === "secret" ? "secret" : "public_ingest",
    name: row.name,
    prefix: row.prefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
  };
}

export type MembershipRow = MembershipRepo.MembershipRow;
export type AuditRow = AuditRepo.AuditRow;

export function toWorkspaceMemberDto(
  row: UserRepo.UserRow,
  role: WorkspaceRole,
): WorkspaceMember {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role,
  };
}

export function toUserSummaryDto(row: UserRepo.UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    ...(row.image === null ? {} : { image: row.image }),
    emailVerified: row.emailVerified,
  };
}

export function toAuditEventDto(
  row: AuditRepo.AuditRow,
  actor: UserRepo.UserRow | null,
): WorkspaceAuditEvent {
  const action = workspaceAuditActionSchema.safeParse(row.action);
  if (!action.success) {
    throw new Error("Invalid persisted audit action");
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    action: action.data,
    actor: actor === null ? null : toUserSummaryDto(actor),
    metadata: AuditRepo.sanitizeAuditMetadata(row.metadataJson),
    createdAt: iso(row.createdAt),
  };
}

export function toIssueTagSummaryDto(
  row: TagRepo.IssueTagRow,
): IssueTagSummary {
  return { id: row.id, name: row.name, slug: row.slug };
}

export function toIssueTagDto(row: TagRepo.IssueTagRow): IssueTag {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    createdAt: iso(row.createdAt),
  };
}

/**
 * Issue DTO mapper. Built field-by-field: fingerprint material, payloads
 * and key hashes can never leak through a spread.
 */
export function toIssueDto(
  row: IssueRepo.IssueRow,
  assignee: UserRepo.UserRow | null,
  tags: TagRepo.IssueTagRow[],
): IssueSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    type:
      row.type === "exception" ||
      row.type === "unhandled_rejection" ||
      row.type === "console_error" ||
      row.type === "network" ||
      row.type === "message"
        ? row.type
        : "message",
    title: row.title,
    normalizedMessage: row.normalizedMessage,
    status:
      row.status === "open" ||
      row.status === "investigating" ||
      row.status === "resolved" ||
      row.status === "ignored"
        ? row.status
        : "open",
    severity: row.severity === "warning" ? "warning" : "error",
    assignee: assignee === null ? null : toUserSummaryDto(assignee),
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    firstRelease: row.firstRelease,
    lastRelease: row.lastRelease,
    occurrenceCount: row.occurrenceCount,
    affectedSessionCount: row.affectedSessionCount,
    tags: tags.map(toIssueTagSummaryDto),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toIssueActivityDto(
  row: IssueActivityRepo.IssueActivityRow,
  actor: UserRepo.UserRow | null,
): IssueActivity {
  const type = row.type;
  return {
    id: row.id,
    issueId: row.issueId,
    type:
      type === "created" ||
      type === "assigned" ||
      type === "unassigned" ||
      type === "status_changed" ||
      type === "comment_added" ||
      type === "regression_detected" ||
      type === "reproduction_generated" ||
      type === "ai_analysis_requested" ||
      type === "ai_analysis_completed" ||
      type === "ai_analysis_failed"
        ? type
        : "created",
    actor: actor === null ? null : toUserSummaryDto(actor),
    metadata:
      typeof row.metadataJson === "object" && row.metadataJson !== null
        ? (row.metadataJson as Record<string, unknown>)
        : {},
    createdAt: iso(row.createdAt),
  };
}

export function toIssueCommentDto(
  row: IssueCommentRepo.IssueCommentRow,
  author: UserRepo.UserRow | null,
): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    author:
      author === null
        ? {
            id: "deleted",
            email: "",
            name: "Deleted user",
            emailVerified: false,
          }
        : toUserSummaryDto(author),
    bodyMarkdown: row.bodyMarkdown,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toOccurrenceDto(row: TelemetryRepo.EventRow): Occurrence {
  return {
    eventId: row.id,
    sessionId: row.telemetrySessionId,
    occurredAt: iso(row.occurredAt),
    receivedAt: iso(row.receivedAt),
    environment: row.environment,
    release: row.release,
    pageUrl: row.pageUrl,
    eventType: row.eventType,
    processingState:
      row.processingState === "pending" ||
      row.processingState === "processed" ||
      row.processingState === "rejected"
        ? row.processingState
        : "pending",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function strArray(value: unknown, max = 10): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string").slice(0, max);
}

/** Maximum stack frames exposed per exception value in event detail. */
const EVENT_DETAIL_MAX_FRAMES = 50;

/** Maximum frames carried by the RS-10 event diagnostic (same bound). */
const EVENT_DIAGNOSTIC_MAX_FRAMES = 50;

function safeFrames(value: unknown): Array<{
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}> {
  const payload = asRecord(value);
  const frames = payload["frames"];
  if (!Array.isArray(frames)) {
    return [];
  }
  return frames.slice(0, EVENT_DETAIL_MAX_FRAMES).map((f) => {
    const frame = asRecord(f);
    const out: {
      filename?: string;
      function?: string;
      lineno?: number;
      colno?: number;
      inApp?: boolean;
    } = {};
    const filename = optStr(frame["filename"]);
    if (filename !== undefined) {
      out.filename = filename;
    }
    const fn = optStr(frame["function"]);
    if (fn !== undefined) {
      out.function = fn;
    }
    const lineno = optNum(frame["lineno"]);
    if (lineno !== undefined && Number.isInteger(lineno) && lineno >= 0) {
      out.lineno = lineno;
    }
    const colno = optNum(frame["colno"]);
    if (colno !== undefined && Number.isInteger(colno) && colno >= 0) {
      out.colno = colno;
    }
    if (typeof frame["in_app"] === "boolean") {
      out.inApp = frame["in_app"];
    }
    return out;
  });
}

/**
 * Picks explicit safe fields from the stored (already ingest-sanitized)
 * payload. Drops everything else: mechanism internals, fingerprint
 * overrides, breadcrumb/SDK data bags and input values never reach the DTO.
 * Malformed stored payloads degrade to safe empty defaults, never throw.
 */
function sanitizeEventData(
  eventType: string,
  payload: unknown,
): EventDetail["data"] {
  const p = asRecord(payload);
  switch (eventType) {
    case "exception": {
      const values = Array.isArray(p["values"]) ? p["values"] : [];
      return {
        values: values.slice(0, 10).map((v) => {
          const value = asRecord(v);
          const out: {
            type: string;
            value: string;
            stacktrace?: {
              frames: ReturnType<typeof safeFrames>;
            };
          } = { type: str(value["type"]), value: str(value["value"]) };
          if (value["stacktrace"] !== undefined) {
            out.stacktrace = { frames: safeFrames(value["stacktrace"]) };
          }
          return out;
        }),
      };
    }
    case "unhandled_rejection":
      return { reason: str(p["reason"]) };
    case "console_error":
      return { args: strArray(p["args"]) };
    case "network": {
      const statusCode = optNum(p["status_code"]);
      return {
        url: str(p["url"]),
        method: str(p["method"]),
        statusCode:
          statusCode !== undefined &&
          Number.isInteger(statusCode) &&
          statusCode >= 0 &&
          statusCode <= 999
            ? statusCode
            : null,
        durationMs: Math.max(0, Math.floor(num(p["duration_ms"]))),
        ...(optStr(p["failure_type"]) !== undefined
          ? { failureType: optStr(p["failure_type"]) as string }
          : {}),
      };
    }
    case "message":
      return { message: str(p["message"]), level: str(p["level"], "info") };
    case "navigation": {
      const fromUrl = optStr(p["from_url"]);
      return {
        fromUrl: fromUrl === undefined ? null : fromUrl,
        toUrl: str(p["to_url"]),
        navigationType: str(p["navigation_type"]),
      };
    }
    case "click": {
      const candidates = Array.isArray(p["locator_candidates"])
        ? p["locator_candidates"]
        : [];
      return {
        locatorCandidates: candidates.slice(0, 5).map((c) => {
          const candidate = asRecord(c);
          return {
            type: str(candidate["type"]),
            value: str(candidate["value"]),
            confidence: num(candidate["confidence"]),
          };
        }),
        elementTag: str(p["element_tag"]),
        ...(optStr(p["element_role"]) !== undefined
          ? { elementRole: optStr(p["element_role"]) as string }
          : {}),
        ...(optStr(p["accessible_name"]) !== undefined
          ? { accessibleName: optStr(p["accessible_name"]) as string }
          : {}),
        ...(optStr(p["route"]) !== undefined
          ? { route: optStr(p["route"]) as string }
          : {}),
      };
    }
    case "input":
      return {
        inputType: str(p["input_type"]),
        ...(optStr(p["input_name"]) !== undefined
          ? { inputName: optStr(p["input_name"]) as string }
          : {}),
        hasValue: p["has_value"] === true,
      };
    case "custom_breadcrumb":
      return {
        category: str(p["category"]),
        message: str(p["message"]),
        level: str(p["level"], "info"),
      };
    case "sdk":
      return {
        sdkName: str(p["sdk_name"]),
        sdkVersion: str(p["sdk_version"]),
        event: str(p["event"]),
      };
    default:
      return { category: "unknown", message: "", level: "info" };
  }
}

/**
 * RS-10 event diagnostic helpers.
 *
 * `parseEventSymbolication` validates the worker-persisted
 * `symbolication_json` against the contract shape: valid enrichment passes
 * through, missing/invalid values degrade to `null` (never an arbitrary DB
 * JSON dump on the DTO).
 *
 * `toEventDiagnostic` derives `{ symbolicationStatus, preferredStack
 * (= mapped ?? raw), rawFrames, mappedFrames nullable }`:
 * - `rawFrames` echoes the worker's raw frames when present, else the
 *   ingested exception stack (same bound as event detail).
 * - `mappedFrames` is the symbolicated view only when the persisted status
 *   is `mapped`/`partially_mapped` with at least one frame; every other
 *   status (or absent enrichment) yields `null` so the UI renders Raw with
 *   the honest persisted status.
 */
function parseEventSymbolication(value: unknown): EventSymbolication | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = eventSymbolicationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function payloadExceptionFrames(payload: unknown): Array<{
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}> {
  const p = asRecord(payload);
  const values = Array.isArray(p["values"]) ? p["values"] : [];
  const out: Array<{
    filename?: string;
    function?: string;
    lineno?: number;
    colno?: number;
    inApp?: boolean;
  }> = [];
  for (const v of values) {
    for (const frame of safeFrames(asRecord(v)["stacktrace"])) {
      out.push(frame);
      if (out.length >= EVENT_DIAGNOSTIC_MAX_FRAMES) {
        return out;
      }
    }
  }
  return out;
}

function toEventDiagnostic(
  eventType: string,
  payload: unknown,
  symbolication: EventSymbolication | null,
): EventDiagnostic {
  const rawFrames =
    symbolication !== null
      ? symbolication.rawFrames.map((f) => ({
          filename: f.filename,
          function: f.function,
          lineno: f.lineno,
          colno: f.colno,
          inApp: f.inApp,
        }))
      : eventType === "exception"
        ? payloadExceptionFrames(payload)
        : [];
  const mapped =
    symbolication !== null &&
    (symbolication.status === "mapped" ||
      symbolication.status === "partially_mapped") &&
    symbolication.mappedFrames.length > 0
      ? symbolication.mappedFrames.map((f) => ({
          filename: f.filename,
          source: f.source,
          function: f.function,
          name: f.name,
          line: f.line,
          column: f.column,
          inApplication: f.inApplication,
          mapped: f.mapped,
        }))
      : null;
  return {
    symbolicationStatus: symbolication === null ? null : symbolication.status,
    rawFrames,
    mappedFrames: mapped,
    preferredStack: mapped ?? rawFrames,
  };
}

export function toEventDetailDto(row: TelemetryRepo.EventRow): EventDetail {
  const symbolication = parseEventSymbolication(row.symbolicationJson);
  const diagnostic = toEventDiagnostic(
    row.eventType,
    row.payloadJson,
    symbolication,
  );
  const base = {
    eventId: row.id,
    sessionId: row.telemetrySessionId,
    issueId: row.issueId,
    occurredAt: iso(row.occurredAt),
    receivedAt: iso(row.receivedAt),
    environment: row.environment,
    release: row.release,
    pageUrl: row.pageUrl,
    processingState:
      row.processingState === "pending" ||
      row.processingState === "processed" ||
      row.processingState === "rejected"
        ? row.processingState
        : ("pending" as const),
    // RS-08 persisted enrichment (validated worker shape only) plus the
    // RS-10 derived diagnostic. Invalid stored JSON degrades to
    // `{ symbolication: absent, diagnostic: raw-only }`, never a dump.
    ...(symbolication === null ? {} : { symbolication }),
    diagnostic,
  };
  const data = sanitizeEventData(row.eventType, row.payloadJson);
  switch (row.eventType) {
    case "exception":
      return {
        ...base,
        eventType: "exception",
        data: data as Extract<EventDetail, { eventType: "exception" }>["data"],
      };
    case "unhandled_rejection":
      return {
        ...base,
        eventType: "unhandled_rejection",
        data: data as Extract<
          EventDetail,
          { eventType: "unhandled_rejection" }
        >["data"],
      };
    case "console_error":
      return {
        ...base,
        eventType: "console_error",
        data: data as Extract<
          EventDetail,
          { eventType: "console_error" }
        >["data"],
      };
    case "network":
      return {
        ...base,
        eventType: "network",
        data: data as Extract<EventDetail, { eventType: "network" }>["data"],
      };
    case "navigation":
      return {
        ...base,
        eventType: "navigation",
        data: data as Extract<EventDetail, { eventType: "navigation" }>["data"],
      };
    case "click":
      return {
        ...base,
        eventType: "click",
        data: data as Extract<EventDetail, { eventType: "click" }>["data"],
      };
    case "input":
      return {
        ...base,
        eventType: "input",
        data: data as Extract<EventDetail, { eventType: "input" }>["data"],
      };
    case "message":
      return {
        ...base,
        eventType: "message",
        data: data as Extract<EventDetail, { eventType: "message" }>["data"],
      };
    case "custom_breadcrumb":
      return {
        ...base,
        eventType: "custom_breadcrumb",
        data: data as Extract<
          EventDetail,
          { eventType: "custom_breadcrumb" }
        >["data"],
      };
    case "sdk":
    default:
      return {
        ...base,
        eventType: "sdk",
        data:
          row.eventType === "sdk"
            ? (data as Extract<EventDetail, { eventType: "sdk" }>["data"])
            : { sdkName: "", sdkVersion: "", event: "unknown" },
      };
  }
}

/**
 * Session DTO: envelope metadata only. Raw host identifiers
 * (`sdk_session_id`, `anonymous_user_hash`) never leave the database.
 */
export function toSessionDto(
  row: TelemetryRepo.TelemetrySessionRow,
): TelemetrySession {
  return {
    id: row.id,
    projectId: row.projectId,
    environment: row.environment,
    release: row.release,
    startedAt: iso(row.startedAt),
    lastSeenAt: iso(row.lastSeenAt),
    initialUrl: row.initialUrl,
    browserName: row.browserName,
    browserVersion: row.browserVersion,
    osName: row.osName,
    osVersion: row.osVersion,
    deviceType: row.deviceType,
    viewportWidth: row.viewportWidth,
    viewportHeight: row.viewportHeight,
    sdkVersion: row.sdkVersion,
  };
}

/** Maximum plain-text summary length for timeline entries. */
const SESSION_EVENT_SUMMARY_MAX = 200;

function truncateSummary(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > SESSION_EVENT_SUMMARY_MAX
    ? `${flat.slice(0, SESSION_EVENT_SUMMARY_MAX - 1)}…`
    : flat;
}

/**
 * One-line plain-text evidence derived from the sanitized payload.
 * Never includes input values, breadcrumb data bags or SDK detail bags.
 */
export function summarizeEventPayload(
  eventType: string,
  payload: unknown,
): string {
  const p = asRecord(payload);
  switch (eventType) {
    case "exception": {
      const first = Array.isArray(p["values"])
        ? asRecord(p["values"][0])
        : asRecord(undefined);
      return truncateSummary(
        `${str(first["type"], "Error")}: ${str(first["value"], "unknown error")}`,
      );
    }
    case "unhandled_rejection":
      return truncateSummary(
        `Unhandled rejection: ${str(p["reason"], "unknown reason")}`,
      );
    case "console_error":
      return truncateSummary(
        strArray(p["args"], 3).join(" ") || "Console error",
      );
    case "network": {
      const status = optNum(p["status_code"]);
      const outcome =
        status !== undefined ? `→ ${status}` : str(p["failure_type"], "failed");
      return truncateSummary(
        `${str(p["method"], "?")} ${str(p["url"], "?")} ${outcome}`,
      );
    }
    case "navigation":
      return truncateSummary(
        `${str(p["from_url"], "∅")} → ${str(p["to_url"], "?")}`,
      );
    case "click": {
      const label =
        optStr(p["accessible_name"]) ??
        optStr(p["element_role"]) ??
        str(p["element_tag"], "element");
      return truncateSummary(`Click ${label}`);
    }
    case "input":
      return truncateSummary(
        `Input ${optStr(p["input_name"]) ?? str(p["input_type"], "interaction")}`,
      );
    case "message":
      return truncateSummary(
        `${str(p["level"], "info")}: ${str(p["message"], "")}`,
      );
    case "custom_breadcrumb":
      return truncateSummary(
        `${str(p["category"], "custom")}: ${str(p["message"], "")}`,
      );
    case "sdk":
      return truncateSummary(`SDK ${str(p["event"], "event")}`);
    default:
      return truncateSummary(`${eventType || "event"}`);
  }
}

export function toSessionEventDto(row: TelemetryRepo.EventRow): SessionEvent {
  return {
    id: row.id,
    sequenceNumber: row.sequenceNumber,
    eventType: row.eventType,
    occurredAt: iso(row.occurredAt),
    receivedAt: iso(row.receivedAt),
    environment: row.environment,
    release: row.release,
    pageUrl: row.pageUrl,
    processingState:
      row.processingState === "pending" ||
      row.processingState === "processed" ||
      row.processingState === "rejected"
        ? row.processingState
        : "pending",
    summary: summarizeEventPayload(row.eventType, row.payloadJson),
  };
}

export function toNotificationDto(
  row: NotificationRepo.NotificationRow,
): Notification {
  const type = row.type;
  return {
    id: row.id,
    type:
      type === "issue_assigned" ||
      type === "issue_comment_mention" ||
      type === "issue_regression" ||
      type === "reproduction_failed" ||
      type === "ai_analysis_completed" ||
      type === "ai_analysis_failed"
        ? type
        : "issue_regression",
    title: row.title,
    body: row.body,
    projectId: row.projectId,
    issueId: row.issueId,
    readAt: row.readAt === null ? null : iso(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

type AiAnalysisRow = AiAnalysisRepo.AiAnalysisRow;

export function toAiAnalysisRequestedByDto(
  row: UserRepo.UserRow | undefined,
): { id: string; email: string; name: string } | null {
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
  };
}

export function toAiAnalysisSummaryDto(
  row: AiAnalysisRow,
  requestedBy: UserRepo.UserRow | undefined,
): {
  id: string;
  eventId: string | null;
  model: string;
  status: "pending" | "ready" | "failed";
  analysisVersion: string;
  requestedBy: { id: string; email: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
} {
  return {
    id: row.id,
    eventId: row.eventId,
    model: row.model,
    status:
      row.status === "pending" ||
      row.status === "ready" ||
      row.status === "failed"
        ? row.status
        : "pending",
    analysisVersion: row.analysisVersion,
    requestedBy: toAiAnalysisRequestedByDto(requestedBy),
    createdAt: iso(row.createdAt),
    completedAt: row.completedAt === null ? null : iso(row.completedAt),
  };
}

export function toAiAnalysisDetailDto(
  row: AiAnalysisRow,
  requestedBy: UserRepo.UserRow | undefined,
): {
  id: string;
  issueId: string;
  eventId: string | null;
  model: string;
  status: "pending" | "ready" | "failed";
  analysisVersion: string;
  requestedBy: { id: string; email: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
  summary: string | null;
  suspectedCause: string | null;
  evidence: Array<{ ref: string; reason: string }> | null;
  reproductionSteps: string[] | null;
  limitations: string[] | null;
  errorCode: string | null;
  errorMessage: string | null;
} {
  const status =
    row.status === "pending" ||
    row.status === "ready" ||
    row.status === "failed"
      ? row.status
      : "pending";
  return {
    id: row.id,
    issueId: row.issueId,
    eventId: row.eventId,
    model: row.model,
    status,
    analysisVersion: row.analysisVersion,
    requestedBy: toAiAnalysisRequestedByDto(requestedBy),
    createdAt: iso(row.createdAt),
    completedAt: row.completedAt === null ? null : iso(row.completedAt),
    summary: row.summary,
    suspectedCause: row.suspectedCause,
    evidence: row.evidenceJson,
    reproductionSteps: row.reproductionStepsJson,
    limitations: row.limitationsJson,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}
