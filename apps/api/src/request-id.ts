import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Honor an incoming request ID only after validation (1-128 chars of
 * alphanumerics plus `.`, `_`, `-`). Anything else is replaced with a
 * freshly generated UUID so malformed or oversized values can never flow
 * into logs, error envelopes or downstream services.
 */
export function resolveRequestId(incoming: unknown): string {
  if (typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}
