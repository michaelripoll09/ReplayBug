import type { NormalizableStackFrame } from "@replaybug/db";
import type { SymbolicationResult } from "./types.js";

/**
 * RS-09 fingerprint-input selection (worker side of the canonical rule).
 *
 * Canonical rule:
 * 1. Custom fingerprints (Block 5) always win — the caller checks the
 *    developer-supplied `fingerprint` first and never consults this helper
 *    for custom grouping (the derivation layer enforces it as well).
 * 2. When at least one USEFUL mapped in-application frame exists
 *    (`mapped: true` with `inApplication: true`), fingerprinting uses the
 *    source-mapped frames so the raw generated filename/content-hash does
 *    NOT dominate grouping. Release stays excluded (existing invariant).
 * 3. Partial symbolication is per-position and deterministic: each stack
 *    position with a mapped frame contributes its original source/symbol/
 *    line (display coordinates); each position without one contributes the
 *    raw sanitized fallback. Order is the original stack order, so the same
 *    enrichment always yields the same fingerprint input.
 * 4. No-map fallback is unchanged: when no useful mapped in-application
 *    frame exists (no_release / release_not_found / map_not_found /
 *    invalid_map / storage_unavailable, empty stacks, mapped non-in-app
 *    only, or a raw/mapped length divergence) this returns null and the
 *    caller derives from the raw sanitized stack exactly as before —
 *    telemetry stays operational and events are never poisoned.
 *
 * The returned frames reuse the `NormalizableStackFrame` shape so the
 * existing `selectTopFrames`/normalize path applies unchanged (in-app
 * preferred, top 5, columns excluded).
 */
export function selectMappedFingerprintFrames(
  result: SymbolicationResult,
): NormalizableStackFrame[] | null {
  const { rawFrames, mappedFrames } = result;
  if (rawFrames.length === 0 || mappedFrames.length === 0) {
    return null;
  }
  if (rawFrames.length !== mappedFrames.length) {
    return null;
  }
  let hasUsefulMappedInApp = false;
  for (const frame of mappedFrames) {
    if (frame.mapped === true && frame.inApplication === true) {
      hasUsefulMappedInApp = true;
      break;
    }
  }
  if (!hasUsefulMappedInApp) {
    return null;
  }
  const selected: NormalizableStackFrame[] = [];
  for (let index = 0; index < mappedFrames.length; index += 1) {
    const mapped = mappedFrames[index];
    const raw = rawFrames[index];
    if (mapped === undefined || raw === undefined) {
      return null;
    }
    if (mapped.mapped === true) {
      selected.push({
        filename: mapped.source,
        function: mapped.function,
        lineno: mapped.line,
        colno: mapped.column,
        in_app: mapped.inApplication,
      });
    } else {
      selected.push({
        filename: raw.filename,
        function: raw.function,
        lineno: raw.lineno,
        colno: raw.colno,
        in_app: raw.inApp,
      });
    }
  }
  return selected;
}
