/**
 * Server-side sanitization - reuses portable logic from SDK.
 * This module contains the same redaction functions for defense in depth.
 * Imported by the ingest service for server-side redaction.
 */

import { SENSITIVE_URL_PARAMS, TELEMETRY_LIMITS } from "@replaybug/contracts";

const REDACTED = "[REDACTED]";

/**
 * URL sanitizer: preserves origin/path, redacts sensitive query parameters,
 * strips credentials, handles malformed URLs gracefully.
 */
export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);

    // Strip userinfo (credentials in URL)
    url.username = "";
    url.password = "";

    // Redact sensitive query parameters
    const params = new URLSearchParams(url.search);
    for (const [key] of params) {
      if (isSensitiveParam(key)) {
        params.set(key, REDACTED);
      }
    }
    // Manually build search string to avoid encoding brackets
    const searchParts: string[] = [];
    for (const [key, value] of params) {
      searchParts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      );
    }
    url.search = searchParts.length > 0 ? "?" + searchParts.join("&") : "";

    return url.toString();
  } catch {
    // Malformed URL: return redacted placeholder to avoid leaking anything
    return REDACTED;
  }
}

/**
 * Check if a parameter name is sensitive.
 */
export function isSensitiveParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_URL_PARAMS.some((sensitive) => lower === sensitive);
}

/**
 * String sanitizer: redacts common secret patterns.
 * Deterministic, not perfect DLP.
 */
export function sanitizeString(input: string): string {
  if (!input) return input;

  let result = input;

  // Bearer tokens: "Bearer <token>" or "Bearer <JWT>"
  result = result.replace(
    /\bBearer\s+[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+/gi,
    `Bearer ${REDACTED}`,
  );
  result = result.replace(
    /\bBearer\s+[A-Za-z0-9_-]{20,}/gi,
    `Bearer ${REDACTED}`,
  );

  // JWT tokens (three base64url parts separated by dots)
  result = result.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    REDACTED,
  );

  // API key patterns: "api_key=...", "key=...", "apikey..."
  result = result.replace(
    /\b(api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*[A-Za-z0-9_-]{16,}/gi,
    `$1=${REDACTED}`,
  );

  // Password patterns: "password=...", "pwd=..."
  result = result.replace(
    /\b(password|pwd|pass)\s*[:=]\s*\S+/gi,
    `$1=${REDACTED}`,
  );

  // Credit card numbers (Luhn not verified, just pattern)
  result = result.replace(/\b(?:\d[ -]*?){13,16}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (/^\d{13,16}$/.test(digits)) {
      return REDACTED;
    }
    return match;
  });

  // Cookie-like patterns: "sessionid=...", "sid=..."
  result = result.replace(
    /\b(session[id_]?|sid|csrf|xsrf|_token)\s*[:=]\s*[A-Za-z0-9_%+-]{16,}/gi,
    `$1=${REDACTED}`,
  );

  // Authorization header values
  result = result.replace(
    /\bAuthorization\s*[:=]\s*[A-Za-z0-9_=+/-]{20,}/gi,
    `Authorization: ${REDACTED}`,
  );

  return result;
}

/**
 * Sanitize context object recursively with depth limit.
 * Redacts sensitive keys and string values.
 */
export function sanitizeContext(
  input: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > TELEMETRY_LIMITS.MAX_CONTEXT_DEPTH) {
    return { "[truncated]": "max_depth_exceeded" };
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    // Skip sensitive keys entirely
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }

    if (typeof value === "string") {
      result[key] = sanitizeString(value);
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        result[key] = value.map((v) =>
          typeof v === "string" ? sanitizeString(v) : v,
        );
      } else {
        result[key] = sanitizeContext(
          value as Record<string, unknown>,
          depth + 1,
        );
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check if a key name is sensitive (should be redacted entirely).
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const sensitiveKeys = [
    "password",
    "pwd",
    "pass",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "client_secret",
    "client_id",
    "authorization",
    "bearer",
    "jwt",
    "cookie",
    "session",
    "sessionid",
    "sid",
    "csrf",
    "xsrf",
    "_token",
    "credit_card",
    "card_number",
    "cvv",
    "cvc",
  ];
  return sensitiveKeys.some((s) => lower === s || lower.endsWith(`_${s}`));
}

/**
 * Extract URLs from a string and sanitize them.
 * Used by redactSecrets to handle strings that contain URLs.
 */
function sanitizeUrlsInString(input: string): string {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  return input.replace(urlRegex, (url) => sanitizeUrl(url));
}

/**
 * Redact secrets from any string (used for event payloads).
 * This is the main entry point for server-side redaction.
 * Handles both pure URLs and strings containing URLs.
 */
export function redactSecrets(input: string): string {
  // First sanitize any embedded URLs, then apply string-pattern redaction.
  return sanitizeString(sanitizeUrlsInString(input));
}

/**
 * Truncate string to max bytes (UTF-8).
 */
export function truncateToBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;

  // Binary search for max byte index <= maxBytes that is a valid UTF-8 boundary
  let low = 0;
  let high = Math.min(maxBytes, bytes.length);
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, mid));
      low = mid;
    } catch {
      high = mid - 1;
    }
  }
  return new TextDecoder().decode(bytes.slice(0, low)) + "…";
}

/**
 * Truncate stack frames inside a Sentry-style `values` array to the
 * contract maximum (ExceptionEventPayload.values[].stacktrace.frames).
 */
function truncateFramesInValues(values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const stacktrace = (value as Record<string, unknown>)["stacktrace"];
    if (!stacktrace || typeof stacktrace !== "object") continue;
    const frames = (stacktrace as Record<string, unknown>)["frames"];
    if (
      Array.isArray(frames) &&
      frames.length > TELEMETRY_LIMITS.MAX_STACK_FRAMES
    ) {
      (stacktrace as Record<string, unknown>)["frames"] = frames.slice(
        0,
        TELEMETRY_LIMITS.MAX_STACK_FRAMES,
      );
    }
  }
}

/**
 * Recursively redact a payload value (server-side defense in depth).
 * - Sensitive keys are fully replaced with [REDACTED].
 * - String values are redacted for embedded URL params and secret patterns.
 * - Recursion is depth-bounded by the shared context depth limit.
 */
function sanitizePayloadValue(value: unknown, depth: number): unknown {
  if (depth > TELEMETRY_LIMITS.MAX_CONTEXT_DEPTH) {
    return { "[truncated]": "max_depth_exceeded" };
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayloadValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      result[key] = sanitizePayloadValue(nested, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Sanitize event payload to size limits and redact secrets.
 * Runs on every ingested payload, including ones from hostile clients.
 */
export function sanitizeEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = sanitizePayloadValue(payload, 0) as Record<string, unknown>;

  // Truncate message-like fields
  for (const key of ["message", "value", "reason"]) {
    if (typeof result[key] === "string") {
      result[key] = truncateToBytes(
        result[key] as string,
        TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH,
      );
    }
  }

  // console_error args is an array of strings
  if (Array.isArray(result["args"])) {
    result["args"] = (result["args"] as unknown[]).map((arg) =>
      typeof arg === "string"
        ? truncateToBytes(arg, TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH)
        : arg,
    );
  }

  // Truncate stack frames (contract shape: values[].stacktrace.frames)
  truncateFramesInValues(result["values"]);

  // Legacy nested shape kept for compatibility
  if (result.payload && typeof result.payload === "object") {
    const legacy = result.payload as Record<string, unknown>;
    truncateFramesInValues(legacy["values"]);
  }

  return result;
}

/**
 * Sanitize batch request - applies to all events in batch
 */
export function sanitizeBatchRequest(
  batch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...batch };

  if (result.events && Array.isArray(result.events)) {
    result.events = result.events.map((event: unknown) => {
      if (event && typeof event === "object") {
        const e = event as Record<string, unknown>;
        return {
          ...e,
          // Keep only the most recent breadcrumbs, matching the client-side
          // ring buffer semantics and the contract maximum.
          breadcrumbs: Array.isArray(e.breadcrumbs)
            ? e.breadcrumbs.slice(-TELEMETRY_LIMITS.MAX_BREADCRUMBS)
            : e.breadcrumbs,
          context: e.context
            ? sanitizeContext(e.context as Record<string, unknown>)
            : undefined,
          payload: e.payload
            ? sanitizeEventPayload(e.payload as Record<string, unknown>)
            : undefined,
        };
      }
      return event;
    });
  }

  if (result.session && typeof result.session === "object") {
    const session = result.session as Record<string, unknown>;
    if (session.initial_url && typeof session.initial_url === "string") {
      session.initial_url = sanitizeUrl(session.initial_url);
    }
  }

  return result;
}
