import { describe, expect, it } from "vitest";
import { normalizeProjectSlug } from "./project.js";
import { normalizeWorkspaceSlug } from "./workspace.js";

const CASES: Array<[string, string]> = [
  ["Hello World", "hello-world"],
  ["hello___world", "hello-world"],
  ["---hello---world---", "hello-world"],
  [" hello   world ", "hello-world"],
  ["HELLO@WORLD!", "helloworld"],
  ["needs_triage", "needs-triage"],
  ["  Frontend ", "frontend"],
  ["needs__triage  now", "needs-triage-now"],
  ["bug!@#fix (v2)", "bugfix-v2"],
  ["--Payment---Flow--", "payment-flow"],
  ["Needs Triage", "needs-triage"],
  ["!!!", ""],
  ["", ""],
  ["   ", ""],
  ["a -_ b", "a-b"],
  ["caf\u00e9 au lait", "caf-au-lait"],
];

describe("normalizeProjectSlug (linear)", () => {
  it.each(CASES)("maps %j to %j", (input, expected) => {
    expect(normalizeProjectSlug(input)).toBe(expected);
  });

  it("matches workspace slug normalization", () => {
    for (const [input] of CASES) {
      expect(normalizeWorkspaceSlug(input)).toBe(normalizeProjectSlug(input));
    }
  });

  it("completes a very long hostile input quickly", () => {
    const hostile = `  ${"a_".repeat(60_000)}!!!${"-".repeat(60_000)}  `;
    const started = Date.now();
    const out = normalizeProjectSlug(hostile);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toBe(`${"a-".repeat(60_000).slice(0, -1)}`);
  }, 15000);
});

describe("normalizeWorkspaceSlug (linear)", () => {
  it.each(CASES)("maps %j to %j", (input, expected) => {
    expect(normalizeWorkspaceSlug(input)).toBe(expected);
  });

  it("stays deterministic across equivalent spellings", () => {
    expect(normalizeWorkspaceSlug("Needs Triage")).toBe(
      normalizeWorkspaceSlug("needs_triage"),
    );
  });
});
