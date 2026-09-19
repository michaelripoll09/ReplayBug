/**
 * RS-08 column semantics — single source of truth.
 *
 * Browser stack frames carry DISPLAY coordinates: line 1-based, column
 * 1-based (as rendered in devtools and `Error.stack`). Source Map v3
 * generated positions are line 1-based but column 0-based (legacy
 * `source-map` behavior preserved by `@jridgewell/trace-mapping`'s
 * `originalPositionFor`, whose needle is `{ line: 1-based, column: 0-based }`
 * and whose result is `{ line: 1-based, column: 0-based }`).
 *
 * Conversion (defined once, used consistently):
 * - display → generated: `generated = max(0, display - 1)` before lookup;
 * - generated → display: `display = generated + 1` when persisting mapped
 *   frames, so raw and mapped frames share the same display coordinate
 *   space for the dashboard (RS-10) and fingerprinting (RS-09).
 *
 * Forgetting the `-1` silently shifts every column by one: adjacent mappings
 * still resolve via greatest-lower-bound, so the bug hides in plain sight.
 * The off-by-one tests pin both directions with a probe map whose
 * generated columns 0 and 1 map to different original lines.
 */

/** Offset between 1-based display columns and 0-based generated columns. */
export const DISPLAY_TO_GENERATED_COLUMN_OFFSET = 1;

/**
 * Convert a browser display column (1-based) to a Source Map v3 generated
 * column (0-based). Malformed non-positive input clamps to 0 instead of
 * going negative.
 */
export function displayColumnToGenerated(displayColumn: number): number {
  if (!Number.isFinite(displayColumn)) {
    return 0;
  }
  const floored = Math.floor(displayColumn);
  return Math.max(0, floored - DISPLAY_TO_GENERATED_COLUMN_OFFSET);
}

/** Convert a Source Map v3 generated column (0-based) to display (1-based). */
export function generatedColumnToDisplay(generatedColumn: number): number {
  if (!Number.isFinite(generatedColumn)) {
    return 1;
  }
  return Math.max(0, Math.floor(generatedColumn)) + 1;
}
