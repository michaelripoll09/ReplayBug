import { describe, expect, it } from "vitest";
import { normalizeTagSlug } from "./tag-slug.js";

/**
 * Deterministic tag slug normalization (Block 6 / T01).
 * Same input always yields the same slug; distinct names that normalize
 * equally share one tag row per project (unique(project_id, slug)).
 */
describe("normalizeTagSlug", () => {
  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeTagSlug("  Frontend ")).toBe("frontend");
  });

  it("converts underscores and whitespace runs to single hyphens", () => {
    expect(normalizeTagSlug("needs__triage  now")).toBe("needs-triage-now");
  });

  it("strips characters outside a-z0-9-hyphen", () => {
    expect(normalizeTagSlug("bug!@#fix (v2)")).toBe("bugfix-v2");
  });

  it("collapses repeated hyphens and trims edge hyphens", () => {
    expect(normalizeTagSlug("--Payment---Flow--")).toBe("payment-flow");
  });

  it("is deterministic across equivalent spellings", () => {
    expect(normalizeTagSlug("Needs Triage")).toBe(
      normalizeTagSlug("needs_triage"),
    );
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(normalizeTagSlug("!!!")).toBe("");
  });
});
