import { describe, expect, it } from "vitest";
import { exceptionEventPayloadSchema, stackFrameSchema } from "./telemetry.js";

/**
 * RS-08 ingest boundary (TDD): the public telemetry schema must NOT accept
 * client-submitted symbolicated frames. Worker enrichment owns the
 * `mapped`/`source`/`symbolication` fields; anything the client sends is
 * stripped at the contract boundary and never trusted downstream.
 */
describe("ingest symbolication boundary", () => {
  it("strips client-submitted mapped/source fields from stack frames", () => {
    const parsed = stackFrameSchema.parse({
      filename: "https://example.com/assets/app.js",
      function: "a",
      lineno: 1,
      colno: 11,
      in_app: true,
      mapped: true,
      source: "src/evil.ts",
      symbolication: { status: "mapped" },
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty("mapped");
    expect(parsed).not.toHaveProperty("source");
    expect(parsed).not.toHaveProperty("symbolication");
    expect(parsed.filename).toBe("https://example.com/assets/app.js");
  });

  it("strips symbolicated frames smuggled inside exception payloads", () => {
    const parsed = exceptionEventPayloadSchema.parse({
      values: [
        {
          type: "TypeError",
          value: "boom",
          stacktrace: {
            frames: [
              {
                filename: "https://example.com/a.js",
                function: "f",
                lineno: 1,
                colno: 1,
                mapped: true,
                source: "src/evil.ts",
              },
            ],
          },
          mechanism: { type: "generic", handled: false },
        },
      ],
    });
    const frame = parsed.values[0]?.stacktrace?.frames[0] as
      Record<string, unknown> | undefined;
    expect(frame).not.toHaveProperty("mapped");
    expect(frame).not.toHaveProperty("source");
  });

  it("rejects a top-level symbolication envelope on ingest payloads", () => {
    const parsed = exceptionEventPayloadSchema.parse({
      values: [
        {
          type: "TypeError",
          value: "boom",
          mechanism: { type: "generic", handled: false },
        },
      ],
      symbolication: { status: "mapped", mappedFrameCount: 1 },
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty("symbolication");
  });
});
