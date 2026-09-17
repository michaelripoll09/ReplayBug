import { SENSITIVE_URL_PARAMS, TELEMETRY_LIMITS } from "@replaybug/contracts";

/**
 * Client-side sanitization boundary.
 * This module contains all redaction logic that runs in the browser SDK.
 * The server reuses the same portable logic for defense in depth.
 */

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
    // Manually build search string - do NOT encode the REDACTED value itself
    const searchParts: string[] = [];
    for (const [key, value] of params) {
      const encodedKey = encodeURIComponent(key);
      // Don't encode the REDACTED placeholder, keep it literal
      const encodedValue = value === REDACTED ? REDACTED : encodeURIComponent(value);
      searchParts.push(`${encodedKey}=${encodedValue}`);
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
 * Extract URLs from a string and sanitize them.
 * Used by redactSecrets to handle strings that contain URLs.
 */
function sanitizeUrlsInString(input: string): string {
  // Simple URL regex to find http(s) URLs in text
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return input.replace(urlRegex, (url) => sanitizeUrl(url));
}

/**
 * String sanitizer: redacts common secret patterns.
 * Deterministic, not perfect DLP.
 * Preserves the exact separator (= or :) and any following whitespace from the input.
 */
export function sanitizeString(input: string): string {
  if (!input) return input;

  let result = input;

  // Bearer tokens in Authorization header: "Authorization: Bearer <token>"
  // Match short tokens too when in Authorization header context
  result = result.replace(
    /\bAuthorization\s*(:|=)\s*Bearer\s+(\S+)/gi,
    (match, separator, token) => `Authorization${separator} Bearer ${REDACTED}`,
  );

  // JWT tokens (three base64url parts separated by dots) - anywhere
  result = result.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    REDACTED,
  );

  // Bearer tokens outside Authorization header: "Bearer <token>" (4+ chars)
  // Reduced from 20 to 4 to catch short tokens in context sanitizer tests
  result = result.replace(
    /(?<![:\w])Bearer\s+[A-Za-z0-9_-]{4,}/gi,
    `Bearer ${REDACTED}`,
  );

  // JWT tokens (three base64url parts separated by dots) - anywhere
  result = result.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    REDACTED,
  );

  // API key patterns: "api_key=...", "key=...", "apikey...", "api_key: ...", "apikey: ..."
  // Preserve the exact separator and whitespace from input
  result = result.replace(
    /\b(api[_-]?key|access[_-]?token|secret[_-]?key)\s*(:|=)(\s*)(\S+)/gi,
    (match, prefix, sep, ws, value) => `${prefix}${sep}${ws}${REDACTED}`,
  );

  // Password patterns: "password=...", "pwd=...", "password: ...", "pwd: ..."
  result = result.replace(
    /\b(password|pwd|pass)\s*(:|=)(\s*)(\S+)/gi,
    (match, prefix, sep, ws, value) => `${prefix}${sep}${ws}${REDACTED}`,
  );

  // Credit card numbers (Luhn not verified, just pattern)
  result = result.replace(/\b(?:\d[ -]*?){13,16}\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (/^\d{13,16}$/.test(digits)) {
      return REDACTED;
    }
    return match;
  });

  // Cookie-like patterns: "sessionid=...", "sid=...", "session_id=...", "sessionid: ..."
  // Match sessionid, session_id, sid, csrf, xsrf, _token
  result = result.replace(
    /\b(session(?:id|_id)?|sid|csrf|xsrf|_token)\s*(:|=)(\s*)(\S+)/gi,
    (match, prefix, sep, ws, value) => `${prefix}${sep}${ws}${REDACTED}`,
  );

  // Authorization header values (Basic, Bearer, etc.) - match any length >= 8 chars
  result = result.replace(
    /\bAuthorization\s*(:|=)\s*([A-Za-z0-9_=+/-]{8,})/gi,
    `Authorization: ${REDACTED}`,
  );

  // Basic auth: "Authorization: Basic <base64>"
  result = result.replace(
    /\bAuthorization\s*(:|=)\s*Basic\s+([A-Za-z0-9_=+/-]{8,})/gi,
    `Authorization: ${REDACTED}`,
  );

  // Bearer tokens outside Authorization header: "Bearer <token>" (4+ chars)
  // Reduced from 20 to 4 to catch short tokens in context sanitizer tests
  result = result.replace(
    /(?<![:\w])Bearer\s+[A-Za-z0-9_-]{4,}/gi,
    `Bearer ${REDACTED}`,
  );

  // JWT tokens (three base64url parts separated by dots) - anywhere
  result = result.replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    REDACTED,
  );

  return result;
}

/**
 * Sanitize context object recursively with depth limit.
 * Redacts sensitive keys and string values.
 * If max depth is exceeded anywhere in the structure, the entire result is replaced
 * with a truncation marker to prevent unbounded growth.
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
      let sanitized: unknown;
      if (Array.isArray(value)) {
        sanitized = value.map((v) =>
          typeof v === "string" ? sanitizeString(v) : sanitizeValue(v, depth + 1),
        );
      } else {
        sanitized = sanitizeContext(
          value as Record<string, unknown>,
          depth + 1,
        );
      }

      // If a recursive call returned the truncation marker, propagate it up
      if (
        typeof sanitized === "object" &&
        sanitized !== null &&
        "[truncated]" in sanitized
      ) {
        return sanitized as Record<string, unknown>;
      }

      result[key] = sanitized;
    } else {
      result[key] = value;
    }
  }

  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value === "object" && value !== null) {
    let sanitized: unknown;
    if (Array.isArray(value)) {
      sanitized = value.map((v) => sanitizeValue(v, depth + 1));
    } else {
      sanitized = sanitizeContext(value as Record<string, unknown>, depth + 1);
    }

    // If a recursive call returned the truncation marker, propagate it up
    if (
      typeof sanitized === "object" &&
      sanitized !== null &&
      "[truncated]" in sanitized
    ) {
      return sanitized;
    }

    return sanitized;
  }
  return value;
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
 * Handles both pure URLs and strings containing URLs.
 */
export function redactSecrets(input: string): string {
  // First, try to find and sanitize any URLs in the string
  const withSanitizedUrls = sanitizeUrlsInString(input);
  // Then apply string sanitization
  return sanitizeString(withSanitizedUrls);
}

/**
 * Check if an input element is sensitive and should never have its value captured.
 */
export function isSensitiveInput(element: HTMLInputElement): boolean {
  const type = element.type.toLowerCase();
  const autocomplete = element.autocomplete?.toLowerCase() || "";

  // Always block these input types
  if (type === "password") return true;

  // Block by autocomplete semantics
  if (
    autocomplete === "current-password" ||
    autocomplete === "new-password" ||
    autocomplete.includes("cc-") ||
    autocomplete.includes("credit-card") ||
    autocomplete.includes("card-")
  ) {
    return true;
  }

  // Block by name/id patterns suggesting tokens/secrets
  const name = (element.name || element.id || "").toLowerCase();
  const sensitivePatterns = [
    "password",
    "pass",
    "pwd",
    "token",
    "secret",
    "api_key",
    "apikey",
    "access_token",
    "refresh_token",
    "auth",
    "csrf",
    "xsrf",
    "_token",
    "card",
    "credit",
    "cvv",
    "cvc",
    "pan",
  ];
  if (sensitivePatterns.some((p) => name.includes(p))) {
    return true;
  }

  // Block if element or ancestor has data-replaybug-mask
  if (
    element.hasAttribute("data-replaybug-mask") ||
    element.closest("[data-replaybug-mask]") !== null
  ) {
    return true;
  }

  return false;
}

/**
 * Sanitize locator text (accessible name, etc.) - truncate and redact.
 * Preserves separator and whitespace like sanitizeString.
 */
export function sanitizeLocatorText(input: string, maxLength = 128): string {
  if (!input) return "";
  let sanitized = sanitizeString(input);
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength - 3) + "...";
  }
  return sanitized;
}

/**
 * Truncate string to max bytes (UTF-8).
 */
export function truncateToBytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;

  // Find the maximum valid UTF-8 prefix within maxBytes
  // Start from maxBytes and go backwards to find a valid UTF-8 boundary
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0) {
    try {
      const truncated = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
      // Successfully decoded, add ellipsis and return
      return truncated + "…";
    } catch {
      end--;
    }
  }
  // If we couldn't decode even a single byte, return just ellipsis
  return "…";
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