import { createHash } from "node:crypto";
import {
  CUSTOM_FINGERPRINT_MAX_ITEMS,
  CUSTOM_FINGERPRINT_MAX_ITEM_LENGTH,
  consoleErrorEventPayloadSchema,
  exceptionEventPayloadSchema,
  messageEventPayloadSchema,
  networkEventPayloadSchema,
  unhandledRejectionEventPayloadSchema,
} from "@replaybug/contracts";
import type { z } from "zod";
import {
  capText,
  formatStackFrame,
  normalizeMessage,
  normalizePath,
  selectTopFrames,
} from "./normalize.js";

/**
 * Deterministic issue descriptors and fingerprints.
 *
 * Grouping key: SHA-256 over `projectId` + separator + canonical signature.
 * The canonical signature is a JSON array so serialization is stable and
 * never depends on object key order. `release` is deliberately excluded:
 * the same defect must be tracked across deployments.
 */

export const ISSUE_TYPES = [
  "exception",
  "unhandled_rejection",
  "console_error",
  "network",
  "message",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_SEVERITIES = ["error", "warning"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** Event types that are processed but never create an issue. */
export const NON_ISSUE_EVENT_TYPES = [
  "navigation",
  "click",
  "input",
  "custom_breadcrumb",
  "sdk",
] as const;

export type StoredEventRejectionCode =
  "malformed_payload" | "unsupported_event_type";

/**
 * Deterministic (non-retryable) stored-event problem. The worker marks the
 * event as `rejected` with this code instead of retrying forever.
 */
export class StoredEventPayloadError extends Error {
  readonly code: StoredEventRejectionCode;

  constructor(code: StoredEventRejectionCode, message: string) {
    super(message);
    this.name = "StoredEventPayloadError";
    this.code = code;
  }
}

export interface IssueDescriptor {
  type: IssueType;
  title: string;
  normalizedMessage: string;
  severity: IssueSeverity;
  /** Canonical normalized signature the fingerprint hash was derived from. */
  signature: string;
  /** SHA-256 hex (64 lowercase chars) grouping key. */
  fingerprint: string;
  grouping: "automatic" | "custom";
}

export interface DeriveEventInput {
  projectId: string;
  eventType: string;
  payload: unknown;
}

export type EventProcessingPlan =
  { kind: "non_issue" } | { kind: "issue"; descriptor: IssueDescriptor };

const TITLE_MAX_LENGTH = 200;
const NORMALIZED_MESSAGE_MAX_LENGTH = 1000;

function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  eventType: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new StoredEventPayloadError(
      "malformed_payload",
      `Stored ${eventType} payload does not match the telemetry contract`,
    );
  }
  return result.data;
}

/**
 * Builds the canonical signature: a JSON array of normalized components in
 * fixed order. Stable across runs and independent of object key order.
 */
export function buildFingerprintSignature(
  components: readonly string[],
): string {
  return JSON.stringify(
    components.map((component) =>
      capText(component, NORMALIZED_MESSAGE_MAX_LENGTH),
    ),
  );
}

/**
 * SHA-256 of `projectId` + ":" + signature, hex lowercase.
 * The project namespace keeps two projects from ever sharing a fingerprint.
 * No secret or HMAC is involved: the fingerprint is not a credential.
 */
export function hashFingerprint(projectId: string, signature: string): string {
  return createHash("sha256")
    .update(`${projectId}:${signature}`, "utf8")
    .digest("hex");
}

/**
 * Cleans a developer-supplied custom fingerprint: trims, collapses
 * whitespace, drops empty entries and bounds item count/length. Values are
 * otherwise taken as-is: they are developer-authored grouping keys, not
 * telemetry to normalize.
 */
export function normalizeCustomFingerprint(
  values: readonly string[] | undefined,
): string[] {
  if (values === undefined || values.length === 0) {
    return [];
  }
  const cleaned: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed === "") {
      continue;
    }
    cleaned.push(capText(trimmed, CUSTOM_FINGERPRINT_MAX_ITEM_LENGTH));
    if (cleaned.length >= CUSTOM_FINGERPRINT_MAX_ITEMS) {
      break;
    }
  }
  return cleaned;
}

/**
 * Decides whether a stored event creates an issue, and with which descriptor.
 * Throws `StoredEventPayloadError` when the stored payload is irrecoverably
 * malformed or the stored event type is unknown.
 */
export function deriveEventProcessingPlan(
  input: DeriveEventInput,
): EventProcessingPlan {
  switch (input.eventType) {
    case "exception":
      return deriveException(input);
    case "unhandled_rejection":
      return deriveUnhandledRejection(input);
    case "console_error":
      return deriveConsoleError(input);
    case "network":
      return deriveNetwork(input);
    case "message":
      return deriveMessageEvent(input);
    case "navigation":
    case "click":
    case "input":
    case "custom_breadcrumb":
    case "sdk":
      return { kind: "non_issue" };
    default:
      throw new StoredEventPayloadError(
        "unsupported_event_type",
        `Unsupported stored event type: ${capText(input.eventType, 64)}`,
      );
  }
}

function buildDescriptor(
  input: DeriveEventInput,
  descriptor: Omit<IssueDescriptor, "fingerprint">,
): IssueDescriptor {
  return {
    ...descriptor,
    fingerprint: hashFingerprint(input.projectId, descriptor.signature),
  };
}

function deriveException(input: DeriveEventInput): EventProcessingPlan {
  const payload = parsePayload(
    exceptionEventPayloadSchema,
    input.payload,
    "exception",
  );
  const primary = payload.values[0];
  if (primary === undefined) {
    throw new StoredEventPayloadError(
      "malformed_payload",
      "Stored exception payload has no values",
    );
  }

  const exceptionClass =
    primary.type.trim() === "" ? "Error" : primary.type.trim();
  const message = normalizeMessage(primary.value);
  const frames = selectTopFrames(primary.stacktrace?.frames ?? []);
  const custom = normalizeCustomFingerprint(payload.fingerprint);

  const components =
    custom.length > 0
      ? ["custom", ...custom]
      : ["exception", exceptionClass, message, ...frames.map(formatStackFrame)];
  const signature = buildFingerprintSignature(components);

  return {
    kind: "issue",
    descriptor: buildDescriptor(input, {
      type: "exception",
      title: capText(`${exceptionClass}: ${message}`, TITLE_MAX_LENGTH),
      normalizedMessage: capText(message, NORMALIZED_MESSAGE_MAX_LENGTH),
      severity: "error",
      signature,
      grouping: custom.length > 0 ? "custom" : "automatic",
    }),
  };
}

function deriveUnhandledRejection(
  input: DeriveEventInput,
): EventProcessingPlan {
  const payload = parsePayload(
    unhandledRejectionEventPayloadSchema,
    input.payload,
    "unhandled_rejection",
  );
  const reason = normalizeMessage(payload.reason);
  const message = reason === "" ? "(no reason)" : reason;
  const signature = buildFingerprintSignature(["unhandled_rejection", message]);

  return {
    kind: "issue",
    descriptor: buildDescriptor(input, {
      type: "unhandled_rejection",
      title: capText(`Unhandled rejection: ${message}`, TITLE_MAX_LENGTH),
      normalizedMessage: capText(message, NORMALIZED_MESSAGE_MAX_LENGTH),
      severity: "error",
      signature,
      grouping: "automatic",
    }),
  };
}

function deriveConsoleError(input: DeriveEventInput): EventProcessingPlan {
  const payload = parsePayload(
    consoleErrorEventPayloadSchema,
    input.payload,
    "console_error",
  );
  const text = normalizeMessage(payload.args.join(" "));
  const message = text === "" ? "(empty console error)" : text;
  const signature = buildFingerprintSignature(["console_error", message]);

  return {
    kind: "issue",
    descriptor: buildDescriptor(input, {
      type: "console_error",
      title: capText(`Console error: ${message}`, TITLE_MAX_LENGTH),
      normalizedMessage: capText(message, NORMALIZED_MESSAGE_MAX_LENGTH),
      severity: "error",
      signature,
      grouping: "automatic",
    }),
  };
}

function deriveNetwork(input: DeriveEventInput): EventProcessingPlan {
  const payload = parsePayload(
    networkEventPayloadSchema,
    input.payload,
    "network",
  );
  const method = payload.method.trim().toUpperCase();
  const normalizedMethod = method === "" ? "GET" : method;
  const path = normalizePath(payload.url);
  const statusCode = payload.status_code ?? null;
  const failureType = payload.failure_type ?? null;
  const isFailure =
    statusCode === null ||
    statusCode === 0 ||
    statusCode >= 400 ||
    failureType !== null;
  if (!isFailure) {
    // A non-failing network event carries no defect: process it, no issue.
    return { kind: "non_issue" };
  }

  const statusLabel =
    statusCode !== null && statusCode > 0
      ? String(statusCode)
      : (failureType ?? "failed");
  const message = `${normalizedMethod} ${path} → ${statusLabel}`;
  const signature = buildFingerprintSignature([
    "network",
    normalizedMethod,
    path,
    statusLabel,
  ]);

  return {
    kind: "issue",
    descriptor: buildDescriptor(input, {
      type: "network",
      title: capText(message, TITLE_MAX_LENGTH),
      normalizedMessage: capText(message, NORMALIZED_MESSAGE_MAX_LENGTH),
      severity: "error",
      signature,
      grouping: "automatic",
    }),
  };
}

function deriveMessageEvent(input: DeriveEventInput): EventProcessingPlan {
  const payload = parsePayload(
    messageEventPayloadSchema,
    input.payload,
    "message",
  );
  const level = payload.level;
  if (level !== "warning" && level !== "error" && level !== "critical") {
    // info/debug are telemetry, not issues.
    return { kind: "non_issue" };
  }

  const text = normalizeMessage(payload.message);
  const message = text === "" ? "(empty message)" : text;
  const severity: IssueSeverity = level === "warning" ? "warning" : "error";
  const signature = buildFingerprintSignature(["message", level, message]);
  const prefix = level === "warning" ? "Warning" : "Error";

  return {
    kind: "issue",
    descriptor: buildDescriptor(input, {
      type: "message",
      title: capText(`${prefix}: ${message}`, TITLE_MAX_LENGTH),
      normalizedMessage: capText(message, NORMALIZED_MESSAGE_MAX_LENGTH),
      severity,
      signature,
      grouping: "automatic",
    }),
  };
}
