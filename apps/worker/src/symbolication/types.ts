/**
 * RS-08 symbolication result types (worker-side only).
 *
 * The worker persists this result as JSONB enrichment on the event row
 * (`events.symbolication_json`) alongside the untouched public-ingest
 * payload. Raw frames are NEVER overwritten: `rawFrames` echoes the
 * ingested coordinates verbatim, `mappedFrames` carries the symbolicated
 * view, and `mappedFrameCount` counts entries with `mapped: true`.
 *
 * Storage keys, content hashes and file bytes are never part of this
 * shape. Logs must carry identifiers and the status only — never frames,
 * sources or payload content.
 */

export const SYMBOLICATION_STATUSES = [
  "mapped",
  "partially_mapped",
  "no_release",
  "release_not_found",
  "map_not_found",
  "invalid_map",
  "storage_unavailable",
] as const;

export type SymbolicationStatus = (typeof SYMBOLICATION_STATUSES)[number];

/** One ingested frame echoed verbatim (display coordinates). */
export interface RawSymbolicationFrame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  inApp: boolean;
}

/**
 * One frame of the symbolicated view. `mapped: true` frames carry the
 * original source location; `mapped: false` frames preserve the raw
 * coordinates and never fabricate a source.
 *
 * `filename`/`source` and `function`/`name` are both populated on purpose:
 * `filename` keeps dashboard code working on raw-shaped data while `source`
 * (original file) and `name` (original symbol) expose the mapped identity.
 * For unmapped frames `source` echoes the raw filename and `name` is null.
 */
export interface MappedSymbolicationFrame {
  filename: string;
  source: string;
  function: string;
  name: string | null;
  line: number;
  column: number;
  inApplication: boolean;
  mapped: boolean;
}

export interface SymbolicationResult {
  status: SymbolicationStatus;
  rawFrames: RawSymbolicationFrame[];
  mappedFrames: MappedSymbolicationFrame[];
  mappedFrameCount: number;
}

/** JSONB-safe guard for values read back from `events.symbolication_json`. */
export function isSymbolicationStatus(
  value: unknown,
): value is SymbolicationStatus {
  return (
    typeof value === "string" &&
    (SYMBOLICATION_STATUSES as readonly string[]).includes(value)
  );
}
