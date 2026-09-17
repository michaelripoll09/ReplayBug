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
 * Redact secrets from any string (used for event payloads).
 * This is the main entry point for server-side redaction.
 */
export function redactSecrets(input: string): string {
  return sanitizeString(sanitizeUrl(input));
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
 * Sanitize event payload to size limits.
 */
export function sanitizeEventPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...payload };

  // Truncate message-like fields
  for (const key of ["message", "value", "reason", "args"]) {
    if (typeof result[key] === "string") {
      result[key] = truncateToBytes(
        result[key] as string,
        TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH,
      );
    }
  }

  // Truncate stack frames
  if (result.payload && typeof result.payload === "object") {
    const payload = result.payload as Record<string, unknown>;
    if (payload.values && Array.isArray(payload.values)) {
      for (const value of payload.values) {
        if (
          value &&
          typeof value === "object" &&
          "stacktrace" in value &&
          value.stacktrace &&
          typeof value.stacktrace === "object" &&
          "frames" in value.stacktrace &&
          Array.isArray(value.stacktrace.frames)
        ) {
          if (
            value.stacktrace.frames.length > TELEMETRY_LIMITS.MAX_STACK_FRAMES
          ) {
            value.stacktrace.frames = value.stacktrace.frames.slice(
              0,
              TELEMETRY_LIMITS.MAX_STACK_FRAMES,
            );
          }
        }
      }
    }
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
