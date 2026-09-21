import type { Job } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import {
  EnvironmentRepo,
  IssueRepo,
  NotificationRepo,
  OccurrenceRepo,
  ProjectRepo,
  SessionRepo,
  findReproductionById,
  insertReproductionActivity,
  lockReproductionById,
  markReproductionFailed,
  markReproductionReady,
  notifyProjectIssueUpdate,
  type Database,
  type ReproductionErrorCode,
} from "@replaybug/db";
import type { TelemetryRepo } from "@replaybug/db";
import {
  buildReproductionPlan,
  renderPlaywrightTest,
  validateGeneratedSyntax,
  validateBaseUrl,
  looksSensitiveValue,
  ReproductionError,
  REPRODUCTION_BASE_URL_REQUIRED,
  REPRODUCTION_UNSUPPORTED_FAILURE,
  REPRODUCTION_OUTPUT_TOO_LARGE,
  REPRODUCTION_INVALID_EVIDENCE,
  type FailureEvidence,
  type GenerationInput,
  type GenerationLocatorCandidate,
  type TimelineEvidenceItem,
} from "@replaybug/reproducer";
import { generateReproductionJobSchema } from "../queues/reproduction.js";

type EventRow = TelemetryRepo.EventRow;

export interface GenerateReproductionDeps {
  db: Database;
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug"> | undefined;
}

export interface GenerateReproductionJobInput {
  reproductionId: string;
}

const TIMELINE_WINDOW = 50;
const SESSION_PAGE_LIMIT = 200;
const ERROR_MESSAGE_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// Worker-local evidence builder (mirrors apps/api buildGenerationInput).
// The worker cannot import apps/api; this copy keeps generation deterministic
// and parity-checked against the API pre-validation. Keep in sync.
// ---------------------------------------------------------------------------

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
      out["element_tag"] = elementTag ?? "";
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
      out["status_code"] =
        typeof status === "number" && Number.isInteger(status) ? status : null;
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
      out["message"] = asString(p["message"]) ?? "";
      out["level"] = asString(p["level"]) ?? "info";
      return out;
    }
    case "custom_breadcrumb": {
      const out: Record<string, unknown> = {};
      out["category"] = asString(p["category"]) ?? "";
      out["message"] = asString(p["message"]) ?? "";
      out["level"] = asString(p["level"]) ?? "info";
      return out;
    }
    case "sdk": {
      const out: Record<string, unknown> = {};
      out["sdk_name"] = asString(p["sdk_name"]) ?? "";
      out["sdk_version"] = asString(p["sdk_version"]) ?? "";
      out["event"] = asString(p["event"]) ?? "";
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
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Exception failure has no assertable message or type.",
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
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Rejection failure has no assertable reason.",
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
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Network failure lacks method or URL.",
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
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Console failure has no assertable text.",
        );
      }
      return { kind: "console_error", expectedMessage: first };
    }
    default: {
      throw new ReproductionError(
        REPRODUCTION_UNSUPPORTED_FAILURE,
        "This failure type cannot be reproduced deterministically.",
      );
    }
  }
}

/**
 * Worker-local generation input builder. Mirrors the API service
 * `buildGenerationInput` (anchor event + issue/project link checks,
 * environment name-match with default fallback, last-50 session window).
 *
 * Throws ReproductionError for deterministic problems (base URL, unsupported
 * failure) and plain Error for transient problems (missing rows, DB reads)
 * so pg-boss retries only the transient case.
 */
export async function buildWorkerGenerationInput(
  db: Database,
  eventId: string,
): Promise<GenerationInput> {
  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined || event.issueId === null) {
    throw new Error(`reproduction evidence not found for event ${eventId}`);
  }
  const issue = await IssueRepo.findIssueById(db, event.issueId);
  if (issue === undefined || issue.projectId !== event.projectId) {
    throw new Error(`reproduction evidence not found for event ${eventId}`);
  }
  const project = await ProjectRepo.findProjectById(db, event.projectId);
  if (project === undefined) {
    throw new Error(`reproduction evidence not found for event ${eventId}`);
  }

  const named = await EnvironmentRepo.findEnvironmentByProjectAndName(
    db,
    project.id,
    event.environment,
  );
  const env =
    named ?? (await EnvironmentRepo.findDefaultEnvironment(db, project.id));
  if (env === undefined || env.baseUrl === null || env.baseUrl.trim() === "") {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Configure the base URL for this environment before generating a test.",
    );
  }
  try {
    validateBaseUrl(env.baseUrl);
  } catch (error) {
    if (error instanceof ReproductionError) {
      throw new ReproductionError(
        REPRODUCTION_BASE_URL_REQUIRED,
        error.message,
      );
    }
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Configure the base URL for this environment before generating a test.",
    );
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

  return {
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
}

// ---------------------------------------------------------------------------
// Deterministic failure mapping + safe diagnostics.
// ---------------------------------------------------------------------------

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  REPRODUCTION_BASE_URL_REQUIRED,
  REPRODUCTION_UNSUPPORTED_FAILURE,
  REPRODUCTION_OUTPUT_TOO_LARGE,
  REPRODUCTION_INVALID_EVIDENCE,
]);

function toErrorCode(code: string): ReproductionErrorCode {
  if (KNOWN_ERROR_CODES.has(code)) {
    return code as ReproductionErrorCode;
  }
  return "REPRODUCTION_FAILED";
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

function notificationCopy(errorCode: ReproductionErrorCode): {
  title: string;
  body: string;
} {
  switch (errorCode) {
    case "REPRODUCTION_BASE_URL_REQUIRED":
      return {
        title: "Reproduction failed: base URL required",
        body: "ReplayBug could not generate a Playwright test because the environment has no base URL configured.",
      };
    case "REPRODUCTION_UNSUPPORTED_FAILURE":
      return {
        title: "Reproduction failed: unsupported failure",
        body: "ReplayBug could not generate a Playwright test because this failure type cannot be reproduced deterministically.",
      };
    case "REPRODUCTION_OUTPUT_TOO_LARGE":
      return {
        title: "Reproduction failed: output too large",
        body: "ReplayBug could not generate a Playwright test because the generated test exceeded the size bound.",
      };
    case "REPRODUCTION_INVALID_EVIDENCE":
      return {
        title: "Reproduction failed: invalid evidence",
        body: "ReplayBug could not generate a Playwright test because the session evidence is incomplete.",
      };
    default:
      return {
        title: "Reproduction failed",
        body: "ReplayBug could not generate a Playwright test for this issue.",
      };
  }
}

// ---------------------------------------------------------------------------
// Processor.
// ---------------------------------------------------------------------------

/**
 * Generate one Playwright reproduction.
 *
 * Flow:
 * 1. Load the row with no lock. Missing rows no-op (deleted after dispatch);
 *    terminal ready/failed rows no-op (idempotent retry).
 * 2. Preload evidence + build plan/render/validate OUTSIDE any transaction
 *    (no SELECT FOR UPDATE held during pure CPU work). Never launches
 *    Playwright.
 * 3. In one transaction: lock the row FOR UPDATE, re-check terminal state,
 *    then mark ready (code + activity + pg_notify) or mark failed
 *    (diagnostics + activity? no — failed still records activity? No:
 *    failed records pg_notify + user notification) exactly once.
 *
 * Deterministic problems (ReproductionError, syntax invalid) mark the row
 * failed and return; they are never rethrown as transient. Anything else
 * throws so pg-boss retries with bounded backoff.
 *
 * Logs carry ids/duration/status only — never generated code, payloads or
 * secrets.
 */
export async function processGenerateReproduction(
  deps: GenerateReproductionDeps,
  job: GenerateReproductionJobInput,
): Promise<void> {
  const logger = deps.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const startedAt = Date.now();
  const { reproductionId } = job;

  const preloaded = await findReproductionById(deps.db, reproductionId);
  if (preloaded === undefined) {
    logger.info({ reproductionId, result: "not-found" }, "reproduction no-op");
    return;
  }
  if (preloaded.status === "ready" || preloaded.status === "failed") {
    logger.info(
      { reproductionId, result: preloaded.status },
      "reproduction already terminal; no-op",
    );
    return;
  }

  const issue = await IssueRepo.findIssueById(deps.db, preloaded.issueId);
  if (issue === undefined) {
    throw new Error(`reproduction issue not found for ${reproductionId}`);
  }
  const project = await ProjectRepo.findProjectById(deps.db, issue.projectId);
  if (project === undefined) {
    throw new Error(`reproduction project not found for ${reproductionId}`);
  }
  const eventId = preloaded.eventId;
  const generatedByUserId = preloaded.generatedByUserId;

  // Event expiry (SET NULL) is deterministic: no evidence left to generate.
  if (eventId === null) {
    await failDeterministic(deps, {
      reproductionId,
      issueId: issue.id,
      projectId: project.id,
      workspaceId: project.workspaceId,
      eventId: null,
      generatedByUserId,
      errorCode: "REPRODUCTION_INVALID_EVIDENCE",
      errorMessage:
        "The occurrence for this reproduction is no longer available.",
      logger,
      startedAt,
    });
    return;
  }

  let code: string;
  let hasRedactedSteps: boolean;
  try {
    const input = await buildWorkerGenerationInput(deps.db, eventId);
    const plan = buildReproductionPlan(input);
    const rendered = renderPlaywrightTest(plan);
    const syntax = validateGeneratedSyntax(rendered.code);
    if (!syntax.ok) {
      throw new ReproductionError(
        "REPRODUCTION_FAILED",
        "Generated test failed syntax validation.",
      );
    }
    code = rendered.code;
    hasRedactedSteps = rendered.hasRedactedSteps;
  } catch (error) {
    if (error instanceof ReproductionError) {
      await failDeterministic(deps, {
        reproductionId,
        issueId: issue.id,
        projectId: project.id,
        workspaceId: project.workspaceId,
        eventId,
        generatedByUserId,
        errorCode: toErrorCode(error.code),
        errorMessage: sanitizeErrorMessage(error.message),
        logger,
        startedAt,
      });
      return;
    }
    throw error;
  }

  await deps.db.transaction(async (tx) => {
    const locked = await lockReproductionById(tx, reproductionId);
    if (locked === undefined) {
      return;
    }
    if (locked.status === "ready" || locked.status === "failed") {
      logger.info(
        {
          reproductionId,
          result: locked.status,
          durationMs: Date.now() - startedAt,
        },
        "reproduction already terminal inside tx; no-op",
      );
      return;
    }
    await markReproductionReady(tx, reproductionId, {
      code,
      hasRedactedSteps,
    });
    await insertReproductionActivity(tx, {
      issueId: issue.id,
      actorUserId: generatedByUserId,
      reproductionId,
    });
    await notifyProjectIssueUpdate(tx, {
      version: 1,
      type: "reproduction.ready",
      projectId: project.id,
      issueId: issue.id,
      eventId,
      reproductionId,
    });
  });

  logger.info(
    {
      reproductionId,
      issueId: issue.id,
      projectId: project.id,
      eventId,
      result: "ready",
      durationMs: Date.now() - startedAt,
    },
    "reproduction generated",
  );
}

async function failDeterministic(
  deps: GenerateReproductionDeps,
  input: {
    reproductionId: string;
    issueId: string;
    projectId: string;
    workspaceId: string;
    eventId: string | null;
    generatedByUserId: string | null;
    errorCode: ReproductionErrorCode;
    errorMessage: string;
    logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
    startedAt: number;
  },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const locked = await lockReproductionById(tx, input.reproductionId);
    if (locked === undefined) {
      return;
    }
    if (locked.status === "ready" || locked.status === "failed") {
      return;
    }
    await markReproductionFailed(tx, input.reproductionId, {
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    await insertReproductionActivity(tx, {
      issueId: input.issueId,
      actorUserId: input.generatedByUserId,
      reproductionId: input.reproductionId,
    });
    await notifyProjectIssueUpdate(tx, {
      version: 1,
      type: "reproduction.failed",
      projectId: input.projectId,
      issueId: input.issueId,
      ...(input.eventId !== null ? { eventId: input.eventId } : {}),
      reproductionId: input.reproductionId,
    });
    if (input.generatedByUserId !== null) {
      const copy = notificationCopy(input.errorCode);
      await NotificationRepo.insertNotification(tx, {
        userId: input.generatedByUserId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        issueId: input.issueId,
        type: "reproduction_failed",
        title: copy.title,
        body: copy.body,
      });
    }
  });

  input.logger.info(
    {
      reproductionId: input.reproductionId,
      issueId: input.issueId,
      projectId: input.projectId,
      result: "failed",
      errorCode: input.errorCode,
      durationMs: Date.now() - input.startedAt,
    },
    "reproduction failed deterministically",
  );
}

/**
 * pg-boss consumer for `replaybug.generate-reproduction`.
 *
 * Validates the versioned job payload with Zod and delegates to
 * `processGenerateReproduction`. Thrown errors become pg-boss failures
 * (bounded retries, then terminal `failed`); deterministic generation
 * problems never throw — they mark the row failed.
 */
export function createGenerateReproductionJobHandler(
  deps: GenerateReproductionDeps & { logger: Logger },
): (jobs: Job<unknown>[]) => Promise<void> {
  return async function handleGenerateReproductionJobs(
    jobs: Job<unknown>[],
  ): Promise<void> {
    for (const job of jobs) {
      const parsed = generateReproductionJobSchema.safeParse(job.data);
      if (!parsed.success) {
        deps.logger.error(
          { jobId: job.id, jobName: job.name },
          "generate-reproduction job payload failed contract validation",
        );
        throw new Error("invalid replaybug.generate-reproduction job payload");
      }
      const reproductionId = parsed.data.reproductionId;
      const startedAt = Date.now();
      try {
        await processGenerateReproduction(deps, { reproductionId });
        deps.logger.info(
          {
            jobId: job.id,
            jobName: job.name,
            reproductionId,
            durationMs: Date.now() - startedAt,
          },
          "generate-reproduction completed",
        );
      } catch (error) {
        deps.logger.error(
          {
            jobId: job.id,
            jobName: job.name,
            reproductionId,
            durationMs: Date.now() - startedAt,
            err: error,
          },
          "generate-reproduction failed; pg-boss will retry or fail the job",
        );
        throw error;
      }
    }
  };
}
