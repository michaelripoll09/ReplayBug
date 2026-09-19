import { createHash } from "node:crypto";
import {
  EnvironmentRepo,
  IssueRepo,
  MembershipRepo,
  OccurrenceRepo,
  ProjectRepo,
  ReproductionRepo,
  SessionRepo,
  UserRepo,
  type Database,
  type ReproductionRow,
  type TelemetryRepo,
} from "@replaybug/db";
import type {
  ReproductionDetail,
  ReproductionGeneratedBy,
  ReproductionListQuery,
  ReproductionSummary,
  WorkspaceRole,
} from "@replaybug/contracts";
import {
  REPRODUCTION_GENERATOR_VERSION,
  ReproductionError,
  looksSensitiveValue,
  validateBaseUrl,
  type FailureEvidence,
  type GenerationInput,
  type GenerationLocatorCandidate,
  type TimelineEvidenceItem,
} from "@replaybug/reproducer";
import {
  notFound,
  internalError,
  validationError,
  reproductionBaseUrlRequired,
  reproductionUnsupportedFailure,
} from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";

type EventRow = TelemetryRepo.EventRow;

const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
const TIMELINE_WINDOW = 50;
const SESSION_PAGE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      if (out.length >= max) {
        break;
      }
    }
  }
  return out;
}

function containsControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
    if (code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const m = await MembershipRepo.findMembership(db, workspaceId, userId);
  return requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
}

/**
 * Stable SHA-256 hex of a caller-supplied idempotency key.
 * Validates non-empty with a 256-char cap.
 */
export function sha256IdempotencyKey(key: string): string {
  if (key.length === 0) {
    throw validationError("Idempotency key must not be empty");
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validationError("Idempotency key exceeds 256 characters");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const ALLOWED_LOCATOR_TYPES = new Set([
  "test_id",
  "role_name",
  "label",
  "id",
  "name",
  "css_fallback",
]);

function sanitizeLocatorCandidates(
  value: unknown,
): GenerationLocatorCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: GenerationLocatorCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const type = asString(item["type"]);
    const candidateValue = asString(item["value"]);
    const confidence = item["confidence"];
    if (type === undefined || candidateValue === undefined) {
      continue;
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      continue;
    }
    if (!ALLOWED_LOCATOR_TYPES.has(type)) {
      continue;
    }
    if (candidateValue.length === 0 || candidateValue.length > 512) {
      continue;
    }
    if (containsControlChars(candidateValue)) {
      continue;
    }
    const lower = candidateValue.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("bearer ") ||
      candidateValue.includes("[REDACTED]")
    ) {
      continue;
    }
    out.push({ type, value: candidateValue, confidence });
    if (out.length >= 5) {
      break;
    }
  }
  return out.slice(0, 5);
}

function sanitizeTimelinePayload(
  eventType: string,
  raw: unknown,
): Record<string, unknown> {
  const p = isRecord(raw) ? raw : {};
  switch (eventType) {
    case "navigation": {
      const out: Record<string, unknown> = {};
      const toUrl = asString(p["to_url"]);
      if (toUrl !== undefined) {
        out["to_url"] = toUrl;
      }
      const fromUrl = asString(p["from_url"]);
      if (fromUrl !== undefined) {
        out["from_url"] = fromUrl;
      } else if (p["from_url"] === null) {
        out["from_url"] = null;
      }
      return out;
    }
    case "click": {
      const out: Record<string, unknown> = {
        locator_candidates: sanitizeLocatorCandidates(p["locator_candidates"]),
      };
      const elementTag = asString(p["element_tag"]);
      if (elementTag !== undefined) {
        out["element_tag"] = elementTag;
      } else {
        out["element_tag"] = "";
      }
      const elementRole = asString(p["element_role"]);
      if (elementRole !== undefined) {
        out["element_role"] = elementRole;
      }
      const accessibleName = asString(p["accessible_name"]);
      if (accessibleName !== undefined) {
        out["accessible_name"] = accessibleName;
      }
      const route = asString(p["route"]);
      if (route !== undefined) {
        out["route"] = route;
      }
      return out;
    }
    case "input": {
      const out: Record<string, unknown> = {};
      const inputType = asString(p["input_type"]);
      out["input_type"] = inputType ?? "text";
      const inputName = asString(p["input_name"]);
      if (inputName !== undefined) {
        out["input_name"] = inputName;
      }
      const inputId = asString(p["input_id"]);
      if (inputId !== undefined) {
        out["input_id"] = inputId;
      }
      out["has_value"] = p["has_value"] === true;
      const rawValue = asString(p["value"]);
      if (rawValue !== undefined) {
        const hint = inputName ?? inputId ?? "";
        if (!looksSensitiveValue(rawValue, hint)) {
          out["value"] = rawValue;
        }
      }
      return out;
    }
    case "network": {
      const out: Record<string, unknown> = {};
      const method = asString(p["method"]);
      if (method !== undefined) {
        out["method"] = method;
      }
      const url = asString(p["url"]);
      if (url !== undefined) {
        out["url"] = url;
      }
      const status = p["status_code"];
      if (typeof status === "number" && Number.isInteger(status)) {
        out["status_code"] = status;
      } else {
        out["status_code"] = null;
      }
      const failureType = asString(p["failure_type"]);
      if (failureType !== undefined) {
        out["failure_type"] = failureType;
      }
      return out;
    }
    case "console":
    case "console_error": {
      return { args: asStringArray(p["args"], 10) };
    }
    case "message": {
      const out: Record<string, unknown> = {};
      const message = asString(p["message"]);
      if (message !== undefined) {
        out["message"] = message;
      } else {
        out["message"] = "";
      }
      const level = asString(p["level"]);
      out["level"] = level ?? "info";
      return out;
    }
    case "custom_breadcrumb": {
      const out: Record<string, unknown> = {};
      const category = asString(p["category"]);
      out["category"] = category ?? "";
      const message = asString(p["message"]);
      out["message"] = message ?? "";
      const level = asString(p["level"]);
      out["level"] = level ?? "info";
      return out;
    }
    case "sdk": {
      const out: Record<string, unknown> = {};
      const sdkName = asString(p["sdk_name"]);
      if (sdkName !== undefined) {
        out["sdk_name"] = sdkName;
      } else {
        out["sdk_name"] = "";
      }
      const sdkVersion = asString(p["sdk_version"]);
      if (sdkVersion !== undefined) {
        out["sdk_version"] = sdkVersion;
      } else {
        out["sdk_version"] = "";
      }
      const event = asString(p["event"]);
      if (event !== undefined) {
        out["event"] = event;
      } else {
        out["event"] = "";
      }
      return out;
    }
    default: {
      return {};
    }
  }
}

function toTimelineItem(row: EventRow): TimelineEvidenceItem {
  const base: TimelineEvidenceItem = {
    sequenceNumber: row.sequenceNumber,
    occurredAt: toIso(row.occurredAt),
    id: row.id,
    eventType: row.eventType,
    payload: sanitizeTimelinePayload(row.eventType, row.payloadJson),
  };
  if (row.pageUrl !== null) {
    return { ...base, pageUrl: row.pageUrl };
  }
  return base;
}

function toFailureEvidence(event: EventRow): FailureEvidence {
  const payload = isRecord(event.payloadJson) ? event.payloadJson : {};
  switch (event.eventType) {
    case "exception": {
      const values = payload["values"];
      const first =
        Array.isArray(values) && isRecord(values[0]) ? values[0] : undefined;
      const expectedType =
        first !== undefined ? asString(first["type"]) : undefined;
      const expectedMessage =
        first !== undefined ? asString(first["value"]) : undefined;
      if (
        (expectedType === undefined || expectedType === "") &&
        (expectedMessage === undefined || expectedMessage === "")
      ) {
        throw reproductionUnsupportedFailure(
          "Exception failure has no assertable message or type",
        );
      }
      return {
        kind: "exception",
        ...(expectedType !== undefined ? { expectedType } : {}),
        ...(expectedMessage !== undefined ? { expectedMessage } : {}),
      };
    }
    case "unhandled_rejection": {
      const reason = asString(payload["reason"]);
      if (reason === undefined || reason === "") {
        throw reproductionUnsupportedFailure(
          "Rejection failure has no assertable reason",
        );
      }
      return { kind: "unhandled_rejection", expectedMessage: reason };
    }
    case "network": {
      const method = asString(payload["method"]);
      const url = asString(payload["url"]);
      if (
        method === undefined ||
        method === "" ||
        url === undefined ||
        url === ""
      ) {
        throw reproductionUnsupportedFailure(
          "Network failure lacks method or URL",
        );
      }
      const statusRaw = payload["status_code"];
      const statusCode =
        typeof statusRaw === "number" && Number.isInteger(statusRaw)
          ? statusRaw
          : null;
      const failureType = asString(payload["failure_type"]);
      return {
        kind: "network",
        method,
        url,
        statusCode,
        ...(failureType !== undefined ? { failureCategory: failureType } : {}),
      };
    }
    case "console_error": {
      const args = asStringArray(payload["args"], 10);
      const first = args[0];
      if (first === undefined || first === "") {
        throw reproductionUnsupportedFailure(
          "Console failure has no assertable text",
        );
      }
      return { kind: "console_error", expectedMessage: first };
    }
    default: {
      throw reproductionUnsupportedFailure(
        "This failure type cannot be reproduced deterministically",
      );
    }
  }
}

/**
 * Build a generator input for one occurrence. Loads the anchor event, its
 * issue + project, the matching environment (name match with default
 * fallback) and the last 50 session events at or before the anchor.
 * Throws NOT_FOUND for missing/cross-tenant links, BASE_URL_REQUIRED when
 * the environment has no usable base URL, UNSUPPORTED_FAILURE otherwise.
 */
export async function buildGenerationInput(
  db: Database,
  eventId: string,
): Promise<GenerationInput> {
  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined) {
    throw notFound("Event");
  }
  if (event.issueId === null) {
    throw notFound("Event");
  }
  const issue = await IssueRepo.findIssueById(db, event.issueId);
  if (issue === undefined) {
    throw notFound("Event");
  }
  if (issue.projectId !== event.projectId) {
    throw notFound("Event");
  }
  const project = await ProjectRepo.findProjectById(db, event.projectId);
  if (project === undefined) {
    throw notFound("Event");
  }

  const named = await EnvironmentRepo.findEnvironmentByProjectAndName(
    db,
    project.id,
    event.environment,
  );
  const env =
    named ?? (await EnvironmentRepo.findDefaultEnvironment(db, project.id));
  if (env === undefined || env.baseUrl === null || env.baseUrl.trim() === "") {
    throw reproductionBaseUrlRequired();
  }
  try {
    validateBaseUrl(env.baseUrl);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw reproductionBaseUrlRequired(error.message);
    }
    throw reproductionBaseUrlRequired();
  }

  const collected: EventRow[] = [];
  let cursor: SessionRepo.EventCursor | undefined = undefined;
  for (;;) {
    const page = await SessionRepo.listSessionEvents(db, {
      sessionId: event.telemetrySessionId,
      limit: SESSION_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    let stop = false;
    for (const row of page.rows) {
      if (row.sequenceNumber > event.sequenceNumber) {
        stop = true;
        break;
      }
      collected.push(row);
    }
    if (stop) {
      break;
    }
    if (page.nextCursor === null) {
      break;
    }
    const decoded = SessionRepo.decodeEventCursor(page.nextCursor);
    if (decoded === null) {
      break;
    }
    cursor = decoded;
  }

  const windowed = collected.slice(-TIMELINE_WINDOW);
  const timeline = windowed.map(toTimelineItem);
  const failure = toFailureEvidence(event);

  const input: GenerationInput = {
    issueId: issue.id,
    issueTitle: issue.title,
    issueType: issue.type,
    occurrenceEventId: event.id,
    environment: event.environment,
    ...(event.release !== null ? { release: event.release } : {}),
    baseUrl: env.baseUrl,
    timeline,
    failure,
  };
  return input;
}

function toGeneratedByFallback(userId: string | null): ReproductionGeneratedBy {
  return {
    id: userId ?? "deleted",
    email: "deleted@replaybug.invalid",
    name: "Deleted user",
  };
}

function resolveGeneratedBy(
  userRow: { id: string; email: string; name: string } | undefined,
  fallbackUserId: string | null,
): ReproductionGeneratedBy {
  if (userRow === undefined) {
    return toGeneratedByFallback(fallbackUserId);
  }
  return {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name,
  };
}

/**
 * Request a Playwright reproduction for one occurrence. Authorizes
 * `reproduction:generate` on the event's project, dedupes on the
 * idempotency hash scoped to user+event+generator version, pre-validates
 * base URL + failure support via buildGenerationInput (no orphan pending),
 * then inserts pending + outbox atomically. No code generation here.
 */
export async function requestReproduction(
  db: Database,
  userId: string,
  eventId: string,
  idempotencyKey: string,
): Promise<{ row: ReproductionRow; deduplicated: boolean }> {
  const hash = sha256IdempotencyKey(idempotencyKey);

  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined) {
    throw notFound("Event");
  }
  const project = await ProjectRepo.findProjectById(db, event.projectId);
  if (project === undefined) {
    throw notFound("Event");
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
  requireWorkspaceCapability(membership, "reproduction:generate");

  const existing = await ReproductionRepo.findReproductionByIdempotency(
    db,
    hash,
  );
  if (
    existing !== undefined &&
    existing.generatedByUserId === userId &&
    existing.eventId === eventId &&
    existing.generatorVersion === REPRODUCTION_GENERATOR_VERSION
  ) {
    return { row: existing, deduplicated: true };
  }

  const input = await buildGenerationInput(db, eventId);

  const row = await db.transaction(async (tx) => {
    const inserted = await ReproductionRepo.insertPendingReproduction(tx, {
      issueId: input.issueId,
      eventId: event.id,
      generatedByUserId: userId,
      generatorVersion: REPRODUCTION_GENERATOR_VERSION,
      language: "typescript",
      framework: "playwright",
      idempotencyKeyHash: hash,
    });
    await ReproductionRepo.insertReproductionOutbox(tx, inserted.id);
    return inserted;
  });
  return { row, deduplicated: false };
}

export function toSummaryDTO(
  row: ReproductionRow,
  generatedBy: ReproductionGeneratedBy,
): ReproductionSummary {
  if (row.eventId === null) {
    throw internalError("Reproduction is missing its event reference");
  }
  const status =
    row.status === "pending" ||
    row.status === "ready" ||
    row.status === "failed"
      ? row.status
      : null;
  if (status === null) {
    throw internalError("Reproduction has an unknown status");
  }
  return {
    id: row.id,
    eventId: row.eventId,
    status,
    hasRedactedSteps: row.hasRedactedSteps,
    generatorVersion: row.generatorVersion,
    generatedBy,
    createdAt: toIso(row.createdAt),
    completedAt: row.completedAt === null ? null : toIso(row.completedAt),
  };
}

export function toDetailDTO(
  row: ReproductionRow,
  generatedBy: ReproductionGeneratedBy,
): ReproductionDetail {
  const summary = toSummaryDTO(row, generatedBy);
  const allowedErrors = new Set([
    "REPRODUCTION_BASE_URL_REQUIRED",
    "REPRODUCTION_UNSUPPORTED_FAILURE",
    "REPRODUCTION_OUTPUT_TOO_LARGE",
    "REPRODUCTION_INVALID_EVIDENCE",
    "REPRODUCTION_FAILED",
  ]);
  const errorCode =
    row.errorCode === null || !allowedErrors.has(row.errorCode)
      ? null
      : (row.errorCode as ReproductionDetail["errorCode"]);
  return {
    ...summary,
    issueId: row.issueId,
    language: row.language,
    framework: row.framework,
    code: row.code,
    errorCode,
    errorMessage: row.errorMessage,
  };
}

/**
 * Deterministic download filename: replaybug-<8>-<8>.spec.ts.
 * Allowlisted to alphanumerics so CRLF, quotes, slashes and traversal
 * can never survive, even for hostile ids.
 */
export function sanitizeDownloadFilename(
  issueId: string,
  eventId: string,
): string {
  const clean = (value: string): string => {
    const alnum = value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    return (alnum === "" ? "00000000" : alnum.padEnd(8, "0")).toLowerCase();
  };
  return `replaybug-${clean(issueId)}-${clean(eventId)}.spec.ts`;
}

export async function listIssueReproductions(
  db: Database,
  userId: string,
  issueId: string,
  query: ReproductionListQuery,
): Promise<{ items: ReproductionSummary[]; nextCursor?: string }> {
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
  requireWorkspaceCapability(membership, "reproduction:read");

  let cursor: ReproductionRepo.ReproductionCursor | undefined = undefined;
  if (query.cursor !== undefined) {
    const decoded = ReproductionRepo.decodeReproductionCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }

  const result = await ReproductionRepo.listIssueReproductions(db, {
    issueId: issue.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });

  const userIds = result.rows
    .map((r) => r.generatedByUserId)
    .filter((id): id is string => id !== null);
  const usersById = await UserRepo.findUsersByIds(db, userIds);
  const items = result.rows.map((row) => {
    const userRow =
      row.generatedByUserId === null
        ? undefined
        : usersById.get(row.generatedByUserId);
    const generatedBy = resolveGeneratedBy(
      userRow === undefined
        ? undefined
        : { id: userRow.id, email: userRow.email, name: userRow.name },
      row.generatedByUserId,
    );
    return toSummaryDTO(row, generatedBy);
  });

  if (result.nextCursor === null) {
    return { items };
  }
  return { items, nextCursor: result.nextCursor };
}

export async function getReproductionById(
  db: Database,
  userId: string,
  reproductionId: string,
): Promise<ReproductionDetail> {
  const row = await ReproductionRepo.findReproductionById(db, reproductionId);
  if (row === undefined) {
    throw notFound("Reproduction");
  }
  const issue = await IssueRepo.findIssueById(db, row.issueId);
  if (issue === undefined) {
    throw notFound("Reproduction");
  }
  const project = await ProjectRepo.findProjectById(db, issue.projectId);
  if (project === undefined) {
    throw notFound("Reproduction");
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
  requireWorkspaceCapability(membership, "reproduction:read");

  let generatedBy: ReproductionGeneratedBy;
  if (row.generatedByUserId === null) {
    generatedBy = resolveGeneratedBy(undefined, null);
  } else {
    const usersById = await UserRepo.findUsersByIds(db, [
      row.generatedByUserId,
    ]);
    const userRow = usersById.get(row.generatedByUserId);
    generatedBy = resolveGeneratedBy(
      userRow === undefined
        ? undefined
        : { id: userRow.id, email: userRow.email, name: userRow.name },
      row.generatedByUserId,
    );
  }
  return toDetailDTO(row, generatedBy);
}

export async function getReproductionDownload(
  db: Database,
  userId: string,
  reproductionId: string,
): Promise<{ code: string; filename: string }> {
  const row = await ReproductionRepo.findReproductionById(db, reproductionId);
  if (row === undefined) {
    throw notFound("Reproduction");
  }
  const issue = await IssueRepo.findIssueById(db, row.issueId);
  if (issue === undefined) {
    throw notFound("Reproduction");
  }
  const project = await ProjectRepo.findProjectById(db, issue.projectId);
  if (project === undefined) {
    throw notFound("Reproduction");
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
  requireWorkspaceCapability(membership, "reproduction:read");

  if (row.status !== "ready" || row.code === null || row.eventId === null) {
    throw notFound("Reproduction");
  }
  return {
    code: row.code,
    filename: sanitizeDownloadFilename(row.issueId, row.eventId),
  };
}
