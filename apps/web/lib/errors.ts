import { ApiError } from "@replaybug/api-client";

/**
 * Error UX mapping: HTTP/envelope failures -> safe, actionable UI copy.
 * Never surfaces stacks, SQL, auth internals or secrets. `requestId` is
 * preserved for 500s so users can report it.
 */

export interface UiError {
  title: string;
  message: string;
  requestId?: string;
  kind:
    "auth" | "forbidden" | "not-found" | "conflict" | "validation" | "server";
}

export function toUiError(error: unknown): UiError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "AUTH_REQUIRED":
        return {
          kind: "auth",
          title: "Session expired",
          message: "Please sign in again to continue.",
          requestId: error.requestId,
        };
      case "FORBIDDEN":
        return {
          kind: "forbidden",
          title: "Not allowed",
          message: "You do not have permission to do that.",
          requestId: error.requestId,
        };
      case "NOT_FOUND":
        return {
          kind: "not-found",
          title: "Not found",
          message: "It may have been deleted or you may not have access.",
        };
      case "CONFLICT":
        return {
          kind: "conflict",
          title: "Already exists",
          message: error.message,
          requestId: error.requestId,
        };
      case "VALIDATION_ERROR":
        return {
          kind: "validation",
          title: "Check the form",
          message: error.message,
          requestId: error.requestId,
        };
      default:
        return {
          kind: "server",
          title: "Something went wrong",
          message: "Please try again. If it persists, report this ID.",
          requestId: error.requestId,
        };
    }
  }
  return {
    kind: "server",
    title: "Something went wrong",
    message: "Please try again.",
  };
}

/** Map backend field details onto React Hook Form field names. */
export function fieldErrorsFromApiError(
  error: unknown,
): Record<string, string> {
  if (!(error instanceof ApiError)) {
    return {};
  }
  const details = error.details;
  if (!Array.isArray(details)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const item of details) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const path = typeof record["path"] === "string" ? record["path"] : "";
    const message =
      typeof record["message"] === "string" ? record["message"] : "";
    if (path.length > 0 && message.length > 0 && out[path] === undefined) {
      out[path] = message;
    }
  }
  return out;
}
