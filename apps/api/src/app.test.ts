import { describe, expect, it } from "vitest";
import { errorEnvelopeSchema } from "@replaybug/contracts";
import { buildApp } from "./app.js";
import { type ApiConfig } from "./config.js";

const baseConfig: ApiConfig = {
  port: 4001,
  host: "127.0.0.1",
  nodeEnv: "test",
  environment: "test",
  version: "0.1.0",
  databaseUrl: "postgres://localhost:5432/replaybug",
  logLevel: "silent",
  authSecret: "test-secret-0123456789abcdef0123456789",
  webUrl: "http://localhost:3000",
  apiUrl: "http://localhost:4001",
  trustedOrigins: ["http://localhost:3000"],
  ingestMaxBatchEvents: 50,
  ingestMaxBodyBytes: 512 * 1024,
  ingestMaxEventBytes: 128 * 1024,
  ingestRateLimitRequestsPerMinute: 60,
  ingestRateLimitEventsPerMinute: 1000,
  userHmacSecret: "test-hmac-secret-0123456789abcdef0123456789",
};

describe("GET /health/live", () => {
  it("returns ok without touching the database", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => {
        throw new Error("must not be called for liveness");
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "api" });
      expect(response.headers["x-request-id"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

describe("GET /health/ready", () => {
  it("returns 200 ready when PostgreSQL is up", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/ready",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ready",
        checks: { database: "up" },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 503 not-ready when PostgreSQL is down", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => false,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/ready",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "not-ready",
        checks: { database: "down" },
      });
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/v1/meta", () => {
  it("returns service metadata", async () => {
    const app = await buildApp({
      config: { ...baseConfig, version: "0.1.0", environment: "test" },
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/meta" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        service: "api",
        version: "0.1.0",
        environment: "test",
      });
    } finally {
      await app.close();
    }
  });
});

describe("request IDs", () => {
  it("honors a valid incoming x-request-id", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { "x-request-id": "demo-request-123" },
      });
      expect(response.headers["x-request-id"]).toBe("demo-request-123");
    } finally {
      await app.close();
    }
  });

  it("generates a request ID when none is supplied", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      const requestId = response.headers["x-request-id"];
      expect(typeof requestId).toBe("string");
      expect(String(requestId).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("replaces an invalid incoming x-request-id", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { "x-request-id": "not valid!!! with spaces" },
      });
      expect(response.headers["x-request-id"]).not.toBe(
        "not valid!!! with spaces",
      );
      expect(
        String(response.headers["x-request-id"] ?? "").length,
      ).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});

describe("error envelope", () => {
  it("returns the contracts envelope for unknown routes without leaking stacks", async () => {
    const app = await buildApp({
      config: baseConfig,
      checkDatabase: async () => true,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/does-not-exist",
      });
      expect(response.statusCode).toBe(404);
      const body = response.json() as Record<string, unknown>;
      expect(() => errorEnvelopeSchema.parse(body)).not.toThrow();
      expect(JSON.stringify(body)).not.toContain("at ");
    } finally {
      await app.close();
    }
  });
});
