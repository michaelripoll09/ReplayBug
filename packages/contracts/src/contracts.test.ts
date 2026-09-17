import { describe, expect, it } from "vitest";
import {
  apiMetaSchema,
  errorEnvelopeSchema,
  liveHealthSchema,
  readyHealthSchema,
} from "./index.js";

describe("health contracts", () => {
  it("accepts a valid liveness payload", () => {
    expect(liveHealthSchema.parse({ status: "ok", service: "api" })).toEqual({
      status: "ok",
      service: "api",
    });
  });

  it("rejects a liveness payload with an unexpected status", () => {
    expect(() =>
      liveHealthSchema.parse({ status: "ready", service: "api" }),
    ).toThrow();
  });

  it("accepts ready and not-ready payloads with database checks", () => {
    expect(
      readyHealthSchema.parse({
        status: "ready",
        checks: { database: "up" },
      }),
    ).toEqual({ status: "ready", checks: { database: "up" } });
    expect(
      readyHealthSchema.parse({
        status: "not-ready",
        checks: { database: "down" },
      }),
    ).toEqual({ status: "not-ready", checks: { database: "down" } });
  });

  it("rejects readiness payloads that omit database checks", () => {
    expect(() => readyHealthSchema.parse({ status: "ready" })).toThrow();
  });
});

describe("api meta contract", () => {
  it("accepts service metadata with version and environment", () => {
    expect(
      apiMetaSchema.parse({
        service: "api",
        version: "0.1.0",
        environment: "development",
      }),
    ).toEqual({ service: "api", version: "0.1.0", environment: "development" });
  });

  it("rejects metadata with an empty version", () => {
    expect(() =>
      apiMetaSchema.parse({
        service: "api",
        version: "",
        environment: "development",
      }),
    ).toThrow();
  });
});

describe("error envelope contract", () => {
  it("accepts a minimal envelope without details", () => {
    expect(
      errorEnvelopeSchema.parse({
        code: "NOT_FOUND",
        message: "Issue not found",
        requestId: "req-123",
      }),
    ).toEqual({
      code: "NOT_FOUND",
      message: "Issue not found",
      requestId: "req-123",
    });
  });

  it("accepts an envelope with validation details", () => {
    const parsed = errorEnvelopeSchema.parse({
      code: "VALIDATION_ERROR",
      message: "Invalid payload",
      requestId: "req-456",
      details: [{ field: "name", message: "Required" }],
    });
    expect(parsed.code).toBe("VALIDATION_ERROR");
  });

  it("rejects envelopes missing the request id", () => {
    expect(() =>
      errorEnvelopeSchema.parse({ code: "INTERNAL_ERROR", message: "Oops" }),
    ).toThrow();
  });
});
