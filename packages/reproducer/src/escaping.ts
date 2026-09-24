/* eslint-disable no-control-regex -- intentional control-character handling for safe code generation */
/**
 * Centralized safe TypeScript literal + comment rendering.
 * All telemetry-derived strings flow through here. Telemetry is untrusted
 * input even after sanitization.
 */

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const UNICODE_SEPARATOR_RE = /[\u2028\u2029]/g;

/** Strip control characters (keeps \n \r \t for later handling). */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_RE, "").replace(UNICODE_SEPARATOR_RE, "");
}

/**
 * Replace every literal occurrence of `search` without a regex, so
 * comment-boundary defenses never depend on an HTML-filtering regex shape.
 */
function replaceAllLiteral(
  value: string,
  search: string,
  replacement: string,
): string {
  if (search === "") {
    return value;
  }
  return value.split(search).join(replacement);
}

/**
 * Render an untrusted string as a single-quoted TypeScript literal.
 * The result is always a valid inert literal: backslash, single quote,
 * newlines and templateInterpolation are escaped; no backticks or ${}
 * can break out because output uses single quotes with full escaping.
 *
 * U+2028/U+2029 need no handling here: `stripControlChars` already removes
 * them before escaping, so they can never reach the generated literal.
 */
export function tsSingleQuoteLiteral(value: string): string {
  const cleaned = stripControlChars(value);
  const escaped = cleaned
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `'${escaped}'`;
}

/**
 * Sanitize a single-line comment fragment: collapse whitespace, remove
 * newlines, comment terminators and control characters.
 */
export function safeCommentFragment(value: string, maxLength = 300): string {
  const collapsed = stripControlChars(value).replace(/(\r\n|\r|\n)/g, " ");
  const defended = replaceAllLiteral(
    replaceAllLiteral(
      replaceAllLiteral(collapsed, "*/", "* /"),
      "<!--",
      "< !--",
    ),
    "-->",
    "-- >",
  );
  const cleaned = defended.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

/** Bound an arbitrary string to a max length deterministically. */
export function boundString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}
