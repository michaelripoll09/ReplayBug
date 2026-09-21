import { describe, expect, it } from "vitest";

import { normalizeCliArgs, parseArgs } from "./verify-generated-test";

describe("verify-generated-test CLI arguments", () => {
  it("normalizes a leading separator before parsing code-file and target", () => {
    expect(normalizeCliArgs(["--", "--code-file", "fixture.spec.ts"])).toEqual([
      "--code-file",
      "fixture.spec.ts",
    ]);

    expect(
      parseArgs(
        normalizeCliArgs([
          "--",
          "--code-file",
          "fixture.spec.ts",
          "--target",
          "http://localhost:5173",
        ]),
      ),
    ).toMatchObject({
      codeFile: "fixture.spec.ts",
      target: "http://localhost:5173",
    });
  });

  it("parses direct arguments without a separator", () => {
    expect(
      parseArgs(["--code-file", "fixture.spec.ts", "--timeout-ms", "5000"]),
    ).toMatchObject({
      codeFile: "fixture.spec.ts",
      timeoutMs: 5000,
    });
  });

  it("rejects a separator in the middle of arguments", () => {
    expect(() => parseArgs(["--code-file", "fixture.spec.ts", "--"])).toThrow(
      "Unknown argument: --",
    );
  });

  it("preserves validation errors for missing code-file and non-numeric timeout values", () => {
    expect(() => parseArgs(["--code-file"])).toThrow(
      "--code-file requires a file path value.",
    );
    expect(() =>
      parseArgs(["--code-file", "fixture.spec.ts", "--timeout-ms", "invalid"]),
    ).toThrow("--timeout-ms must be a positive integer.");
  });
});
