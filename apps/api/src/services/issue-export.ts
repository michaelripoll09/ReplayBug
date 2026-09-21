import {
  IssueRepo,
  OccurrenceRepo,
  ProjectRepo,
  ReproductionRepo,
  SessionRepo,
  TagRepo,
  type Database,
  type TelemetryRepo,
} from "@replaybug/db";
import {
  issueExportSchema,
  reproductionErrorCodeSchema,
  reproductionStatusSchema,
  type EventDiagnostic,
  type IssueExport,
  type IssueExportIssue,
  type IssueExportMappedFrame,
  type IssueExportRawFrame,
  type IssueExportReproduction,
  type IssueExportStack,
  type IssueExportQuery,
} from "@replaybug/contracts";
import { notFound } from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
} from "../authz/guards.js";
import { membershipOrThrow } from "./issues.js";
import {
  toEventDetailDto,
  toIssueDto,
  toOccurrenceDto,
  toSessionEventDto,
} from "./dto.js";

const TIMELINE_BEFORE = 20;
const TIMELINE_AFTER = 5;
const REPRODUCTION_LIMIT = 20;

type EventRow = TelemetryRepo.EventRow;

type IssueRow = IssueRepo.IssueRow;

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toRawFrame(
  frame: EventDiagnostic["rawFrames"][number],
): IssueExportRawFrame {
  return {
    ...(frame.filename !== undefined ? { filename: frame.filename } : {}),
    ...(frame.function !== undefined ? { function: frame.function } : {}),
    ...(frame.lineno !== undefined ? { lineno: frame.lineno } : {}),
    ...(frame.colno !== undefined ? { colno: frame.colno } : {}),
    ...(frame.inApp !== undefined ? { inApp: frame.inApp } : {}),
  };
}

function toMappedFrame(
  frame: NonNullable<EventDiagnostic["mappedFrames"]>[number],
): IssueExportMappedFrame {
  return {
    filename: frame.filename,
    source: frame.source,
    function: frame.function,
    name: frame.name,
    line: frame.line,
    column: frame.column,
    inApplication: frame.inApplication,
    mapped: frame.mapped,
  };
}

function toPreferredFrame(
  frame: EventDiagnostic["preferredStack"][number],
): IssueExportRawFrame | IssueExportMappedFrame {
  if ("source" in frame) {
    return toMappedFrame(frame);
  }
  return toRawFrame(frame);
}

function toExportStack(event: EventRow): IssueExportStack {
  const diagnostic = toEventDetailDto(event).diagnostic;
  if (diagnostic === undefined) {
    return {
      symbolicationStatus: null,
      rawFrames: [],
      mappedFrames: null,
      preferredStack: [],
    };
  }
  return {
    symbolicationStatus: diagnostic.symbolicationStatus,
    rawFrames: diagnostic.rawFrames.map(toRawFrame),
    mappedFrames:
      diagnostic.mappedFrames === null
        ? null
        : diagnostic.mappedFrames.map(toMappedFrame),
    preferredStack: diagnostic.preferredStack.map(toPreferredFrame),
  };
}

function toIssueExportIssue(
  row: IssueRow,
  tags: Awaited<ReturnType<typeof TagRepo.listTagsForIssue>>,
): IssueExportIssue {
  const mapped = toIssueDto(row, null, tags);
  return {
    id: mapped.id,
    projectId: mapped.projectId,
    type: mapped.type,
    title: mapped.title,
    normalizedMessage: mapped.normalizedMessage,
    status: mapped.status,
    severity: mapped.severity,
    firstSeenAt: mapped.firstSeenAt,
    lastSeenAt: mapped.lastSeenAt,
    resolvedAt: mapped.resolvedAt,
    firstRelease: mapped.firstRelease,
    lastRelease: mapped.lastRelease,
    occurrenceCount: mapped.occurrenceCount,
    affectedSessionCount: mapped.affectedSessionCount,
    tags: mapped.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
    })),
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
  };
}

function toExportStatus(value: string): IssueExportReproduction["status"] {
  const parsed = reproductionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "pending";
}

function toExportErrorCode(
  value: string | null,
): IssueExportReproduction["errorCode"] {
  if (value === null) {
    return null;
  }
  const parsed = reproductionErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toIssueExportReproduction(
  row: ReproductionRepo.ReproductionRow,
): IssueExportReproduction {
  return {
    id: row.id,
    eventId: row.eventId,
    status: toExportStatus(row.status),
    language: row.language,
    framework: row.framework,
    hasRedactedSteps: row.hasRedactedSteps,
    generatorVersion: row.generatorVersion,
    errorCode: toExportErrorCode(row.errorCode),
    completedAt: row.completedAt === null ? null : toIso(row.completedAt),
    createdAt: toIso(row.createdAt),
  };
}

function compareTimelineRows(a: EventRow, b: EventRow): number {
  if (a.sequenceNumber !== b.sequenceNumber) {
    return a.sequenceNumber - b.sequenceNumber;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

async function findExportAnchor(
  db: Database,
  issue: IssueRow,
  eventId: string | undefined,
): Promise<EventRow | null> {
  if (eventId !== undefined) {
    const event = await OccurrenceRepo.findEventById(db, eventId);
    if (
      event === undefined ||
      event.issueId !== issue.id ||
      event.projectId !== issue.projectId
    ) {
      // An explicit event must be a retained occurrence of this issue. Do not
      // fall back to the newest event: that could disclose another issue.
      throw notFound("Event");
    }
    return event;
  }

  const result = await OccurrenceRepo.listIssueOccurrences(db, {
    issueId: issue.id,
    limit: 1,
  });
  return result.rows[0] ?? null;
}

async function loadTimeline(
  db: Database,
  anchor: EventRow,
): Promise<ReturnType<typeof toSessionEventDto>[]> {
  const context = await SessionRepo.getTimelineContext(db, {
    sessionId: anchor.telemetrySessionId,
    anchorSequence: anchor.sequenceNumber,
    anchorId: anchor.id,
    before: TIMELINE_BEFORE,
    after: TIMELINE_AFTER,
  });
  return [...context.before, anchor, ...context.after]
    .sort(compareTimelineRows)
    .map(toSessionEventDto);
}

/**
 * Builds one explicitly allowlisted issue export after applying the same
 * issue:read tenant and capability checks as issue detail.
 */
export async function getIssueExport(
  db: Database,
  userId: string,
  issueId: string,
  query: IssueExportQuery,
): Promise<IssueExport> {
  const issue = await IssueRepo.findIssueById(db, issueId);
  if (issue === undefined) {
    throw notFound("Issue");
  }
  const project = await ProjectRepo.findProjectById(db, issue.projectId);
  if (project === undefined) {
    throw notFound("Issue");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireProjectAccess(
    {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    },
    { id: project.id, workspaceId: project.workspaceId },
  );
  requireWorkspaceCapability(membership, "issue:read");

  const [tags, anchor, reproductions] = await Promise.all([
    TagRepo.listTagsForIssue(db, issue.id),
    findExportAnchor(db, issue, query.eventId),
    ReproductionRepo.listIssueReproductions(db, {
      issueId: issue.id,
      limit: REPRODUCTION_LIMIT,
    }),
  ]);

  const result: IssueExport = {
    exportedAt: new Date().toISOString(),
    issue: toIssueExportIssue(issue, tags),
    occurrence: anchor === null ? null : toOccurrenceDto(anchor),
    stack: anchor === null ? null : toExportStack(anchor),
    timeline: anchor === null ? [] : await loadTimeline(db, anchor),
    reproductions: reproductions.rows.map(toIssueExportReproduction),
  };
  return issueExportSchema.parse(result);
}

/**
 * IDs are the only input allowed into the download filename. Keep only the
 * conservative header-safe subset so even direct callers cannot inject CRLF,
 * quotes, slashes or a title into Content-Disposition.
 */
export function sanitizeIssueExportFilename(issueId: string): string {
  const safeId = issueId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  return `replaybug-issue-${safeId || "unknown"}.json`;
}

export function serializeIssueExport(exportData: IssueExport): string {
  return JSON.stringify(issueExportSchema.parse(exportData));
}
