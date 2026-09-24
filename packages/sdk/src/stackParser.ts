/**
 * Deterministic linear stack-frame parser.
 *
 * Replaces the previous polynomial backtracking regex with an explicit
 * parser: trim leading whitespace, require the `at ` prefix, split an
 * optional `functionName (location)` wrapper, then parse the location from
 * the right (`filename:line:column`, `filename:line`, filename-only) only
 * accepting decimal-digit line/column components.
 *
 * Parsing numeric suffixes from the right keeps `http(s)://` URLs, ports,
 * and Windows drive prefixes (`C:\...`) intact. Sanitization and `in_app`
 * classification match the previous behavior.
 */
import { sanitizeString } from "./sanitize.js";

/** Whitespace accepted between `at` and the frame body. */
function isFrameWhitespace(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0x09 || // \t
    code === 0x0a || // \n
    code === 0x0b || // \v
    code === 0x0c || // \f
    code === 0x0d || // \r
    code === 0xa0 ||
    code === 0xfeff
  );
}

/** True when every character is an ASCII decimal digit (non-empty). */
function isDigits(value: string): boolean {
  if (value === "") {
    return false;
  }
  for (const ch of value) {
    if (ch < "0" || ch > "9") {
      return false;
    }
  }
  return true;
}

/**
 * Split `functionName (location)` wrappers. Returns the function part (may
 * be "") and the location part. A trailing `)` without a ` (` separator
 * only strips that paren, mirroring the previous regex fallback.
 */
function splitFunctionWrapper(body: string): {
  fn: string | undefined;
  location: string;
} {
  if (!body.endsWith(")")) {
    return { fn: undefined, location: body };
  }
  const sep = body.indexOf(" (");
  if (sep === -1) {
    return { fn: undefined, location: body.slice(0, -1) };
  }
  return {
    fn: body.slice(0, sep),
    location: body.slice(sep + 2, -1),
  };
}

/**
 * Parse one location from the right: `filename:line:column`,
 * `filename:line`, or filename-only. Line/column are accepted only when
 * they are decimal digits; a trailing bare `:` keeps the whole remainder
 * as the filename, as before.
 */
function parseLocation(location: string): {
  filename: string;
  lineno: number | undefined;
  colno: number | undefined;
} {
  const lastColon = location.lastIndexOf(":");
  if (lastColon !== -1 && isDigits(location.slice(lastColon + 1))) {
    const beforeCol = location.slice(0, lastColon);
    const secondColon = beforeCol.lastIndexOf(":");
    if (secondColon !== -1 && isDigits(beforeCol.slice(secondColon + 1))) {
      return {
        filename: beforeCol.slice(0, secondColon),
        lineno: parseInt(beforeCol.slice(secondColon + 1), 10) || undefined,
        colno: parseInt(location.slice(lastColon + 1), 10) || undefined,
      };
    }
    return {
      filename: beforeCol,
      lineno: parseInt(location.slice(lastColon + 1), 10) || undefined,
      colno: undefined,
    };
  }
  return { filename: location, lineno: undefined, colno: undefined };
}

/** Parse a single stack line; returns null for non-frame lines. */
export function parseStackLine(line: string): Record<string, unknown> | null {
  let rest = line;
  let start = 0;
  while (start < rest.length && isFrameWhitespace(rest.charCodeAt(start))) {
    start += 1;
  }
  rest = rest.slice(start);
  if (
    !rest.startsWith("at") ||
    rest.length <= 2 ||
    !isFrameWhitespace(rest.charCodeAt(2))
  ) {
    return null;
  }
  let body = rest.slice(3);
  while (body !== "" && isFrameWhitespace(body.charCodeAt(0))) {
    body = body.slice(1);
  }
  if (body === "") {
    return null;
  }
  const { fn, location } = splitFunctionWrapper(body);
  const { filename, lineno, colno } = parseLocation(location);
  return {
    function: fn !== undefined && fn !== "" ? sanitizeString(fn) : undefined,
    filename: sanitizeString(filename),
    lineno,
    colno,
    in_app: !/(node_modules|webpack|\/vendor\/)/.test(filename),
  };
}

/**
 * Parse stack frames from an error stack, keeping at most `maxFrames`.
 * Non-frame lines are skipped. A CR left by CRLF line endings is stripped
 * per line before parsing so wrapped frames are still recognized; LF-only
 * behavior is unchanged.
 */
export function parseStackFrames(
  stack: string,
  maxFrames: number,
): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const lines = stack.split("\n");
  for (const line of lines) {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    const frame = parseStackLine(normalizedLine);
    if (frame !== null) {
      frames.push(frame);
    }
  }
  return frames.slice(0, maxFrames);
}
