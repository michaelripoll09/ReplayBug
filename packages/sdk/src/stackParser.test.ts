// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseStackLine, parseStackFrames } from "./stackParser.js";

function frameOf(line: string): Record<string, unknown> | null {
  return parseStackLine(line);
}

describe("parseStackLine", () => {
  it("parses function + https URL with line and column", () => {
    expect(frameOf("    at fn (https://example.com/app.js:10:20)")).toEqual({
      function: "fn",
      filename: "https://example.com/app.js",
      lineno: 10,
      colno: 20,
      in_app: true,
    });
  });

  it("parses bare https URL frames", () => {
    expect(frameOf("at https://example.com/app.js:10:20")).toEqual({
      function: undefined,
      filename: "https://example.com/app.js",
      lineno: 10,
      colno: 20,
      in_app: true,
    });
  });

  it("parses parenthesized file URLs", () => {
    expect(frameOf("at fn (/app.js:10:20)")).toEqual({
      function: "fn",
      filename: "/app.js",
      lineno: 10,
      colno: 20,
      in_app: true,
    });
  });

  it("parses file + line without column", () => {
    expect(frameOf("at /app.js:10")).toEqual({
      function: undefined,
      filename: "/app.js",
      lineno: 10,
      colno: undefined,
      in_app: true,
    });
  });

  it("falls back to filename-only", () => {
    expect(frameOf("at fn (native)")).toEqual({
      function: "fn",
      filename: "native",
      lineno: undefined,
      colno: undefined,
      in_app: true,
    });
  });

  it("keeps Windows paths with drive letters intact", () => {
    expect(frameOf("at fn (C:\\app\\file.js:10:20)")).toEqual({
      function: "fn",
      filename: "C:\\app\\file.js",
      lineno: 10,
      colno: 20,
      in_app: true,
    });
  });

  it("keeps ports inside URLs intact", () => {
    expect(frameOf("at fn (http://localhost:5173/src/App.tsx:42:7)")).toEqual({
      function: "fn",
      filename: "http://localhost:5173/src/App.tsx",
      lineno: 42,
      colno: 7,
      in_app: true,
    });
  });

  it("supports function names with spaces", () => {
    expect(frameOf("at my function (/app.js:1:2)")).toEqual({
      function: "my function",
      filename: "/app.js",
      lineno: 1,
      colno: 2,
      in_app: true,
    });
  });

  it("marks vendored frames as not in_app", () => {
    expect(
      frameOf("at fn (https://cdn.test/node_modules/lib/index.js:1:1)")?.in_app,
    ).toBe(false);
    expect(frameOf("at fn (/vendor/lib.js:1:1)")?.in_app).toBe(false);
  });

  it("rejects malformed lines", () => {
    expect(frameOf("not a frame")).toBeNull();
    expect(frameOf("at ")).toBeNull();
    expect(frameOf("at")).toBeNull();
    expect(frameOf("Error: boom")).toBeNull();
  });

  it("accepts only decimal-digit line/column suffixes", () => {
    expect(frameOf("at /app.js:1x:2")).toEqual({
      function: undefined,
      filename: "/app.js:1x",
      lineno: 2,
      colno: undefined,
      in_app: true,
    });
    expect(frameOf("at /app.js:xy")).toEqual({
      function: undefined,
      filename: "/app.js:xy",
      lineno: undefined,
      colno: undefined,
      in_app: true,
    });
  });
});

describe("parseStackFrames", () => {
  it("parses a realistic V8 stack and bounds frame count", () => {
    const stack = [
      "Error: boom",
      "    at fn (https://example.com/app.js:10:20)",
      "    at https://example.com/other.js:5:1",
      "    at Array.forEach (<anonymous>)",
      "    at node:internal/timers:11:5",
    ].join("\n");
    const frames = parseStackFrames(stack, 10);
    expect(frames).toHaveLength(4);
    expect(frames[0]).toMatchObject({
      function: "fn",
      filename: "https://example.com/app.js",
      lineno: 10,
      colno: 20,
    });
    expect(frames[1]).toMatchObject({
      filename: "https://example.com/other.js",
      lineno: 5,
      colno: 1,
    });
    expect(frames[2]).toMatchObject({ filename: "<anonymous>" });
  });

  it("respects the frame cap", () => {
    const stack = Array.from(
      { length: 200 },
      (_, i) => `at fn${i} (/app.js:${i + 1}:1)`,
    ).join("\n");
    expect(parseStackFrames(stack, 100)).toHaveLength(100);
  });

  it("completes a very long hostile line quickly", () => {
    const hostile = `    at ${"a".repeat(100_000)} (${"b".repeat(50_000)}.js:${"1".repeat(25_000)}:${"2".repeat(25_000)})`;
    const started = Date.now();
    const frames = parseStackFrames(hostile, 100);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.filename).toBe(`${"b".repeat(50_000)}.js`);
  }, 15000);
});
