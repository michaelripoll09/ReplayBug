import { describe, expect, it } from "vitest";
import {
  DISPLAY_TO_GENERATED_COLUMN_OFFSET,
  displayColumnToGenerated,
  generatedColumnToDisplay,
} from "./columns.js";

/**
 * RS-08 column semantics (TDD).
 *
 * Single source of truth for the browser-display vs Source Map v3
 * generated-column conversion. Off-by-one regressions here silently shift
 * every symbolicated column, so both directions are pinned.
 */
describe("column conversion", () => {
  it("documents the offset once", () => {
    expect(DISPLAY_TO_GENERATED_COLUMN_OFFSET).toBe(1);
  });

  it("converts display (1-based) to generated (0-based) with clamping", () => {
    expect(displayColumnToGenerated(1)).toBe(0);
    expect(displayColumnToGenerated(11)).toBe(10);
    // Display column 0 is malformed input; clamp instead of going negative.
    expect(displayColumnToGenerated(0)).toBe(0);
    expect(displayColumnToGenerated(-5)).toBe(0);
  });

  it("converts generated (0-based) back to display (1-based)", () => {
    expect(generatedColumnToDisplay(0)).toBe(1);
    expect(generatedColumnToDisplay(10)).toBe(11);
  });

  it("round-trips for sane inputs", () => {
    for (const display of [1, 2, 11, 100]) {
      expect(generatedColumnToDisplay(displayColumnToGenerated(display))).toBe(
        display,
      );
    }
  });
});
