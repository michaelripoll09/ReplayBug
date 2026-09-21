/**
 * Source Map v3 validation (RS-06 shared home).
 *
 * `.map` uploads must parse as Source Map v3 JSON (version===3, sources
 * array, valid names when present, mappings string, valid file/sourceRoot
 * when present) BEFORE anything is persisted. The API maps failures to
 * 400 INVALID_SOURCE_MAP with no row and no stored file; the worker
 * (RS-08) reuses the same validator when loading maps for symbolication.
 *
 * Index maps (`sections` without `mappings`) are rejected: the worker only
 * consumes basic maps with a `mappings` string.
 */
import { InvalidSourceMapError } from "./errors.js";

export interface ValidatedSourceMap {
  version: 3;
  sources: string[];
  names?: string[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
}

function fail(message: string): never {
  throw new InvalidSourceMapError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * Decode UTF-8 (strict), parse JSON, and validate the Source Map v3
 * shape. Returns the validated view — never executable content.
 */
export function validateSourceMapBytes(bytes: Uint8Array): ValidatedSourceMap {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Source map is not valid UTF-8");
  }
  // `text` is always assigned: `fail` throws (typed as never).
  const parsed: unknown = parseJson(text as string);
  if (!isRecord(parsed)) {
    fail("Source map must be a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc["version"] !== 3) {
    fail("Source map version must be 3");
  }
  if (!isStringArray(doc["sources"])) {
    fail("Source map sources must be an array of strings");
  }
  if (doc["names"] !== undefined && !isStringArray(doc["names"])) {
    fail("Source map names must be an array of strings when present");
  }
  if (typeof doc["mappings"] !== "string") {
    fail("Source map mappings must be a string");
  }
  if (doc["file"] !== undefined && typeof doc["file"] !== "string") {
    fail("Source map file must be a string when present");
  }
  if (
    doc["sourceRoot"] !== undefined &&
    typeof doc["sourceRoot"] !== "string"
  ) {
    fail("Source map sourceRoot must be a string when present");
  }
  if (
    doc["sourcesContent"] !== undefined &&
    !(
      Array.isArray(doc["sourcesContent"]) &&
      doc["sourcesContent"].every(
        (entry) => typeof entry === "string" || entry === null,
      )
    )
  ) {
    fail("Source map sourcesContent must be an array when present");
  }
  const result: ValidatedSourceMap = {
    version: 3,
    sources: doc["sources"] as string[],
    mappings: doc["mappings"] as string,
  };
  if (isStringArray(doc["names"])) {
    result.names = doc["names"];
  }
  if (typeof doc["file"] === "string") {
    result.file = doc["file"];
  }
  if (typeof doc["sourceRoot"] === "string") {
    result.sourceRoot = doc["sourceRoot"];
  }
  return result;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("Source map is not valid JSON");
  }
}
