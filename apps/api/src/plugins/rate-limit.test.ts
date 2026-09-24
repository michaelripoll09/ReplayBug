import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApp } from "../app.js";
import { testApiConfig } from "../test-helpers.js";
import type { AppInstance } from "../instance.js";
import { registerErrorHandler } from "./error-handler.js";
import {
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW,
  RATE_LIMIT_POLICIES,
  registerRateLimit,
} from "./rate-limit.js";
import { registerRequestId } from "./request-id.js";

type NodeEnv = "development" | "test";

/**
 * Isolated limiter wiring with non-test behavior by default: the real
 * `registerRateLimit` plugin (official `@fastify/rate-limit`, global) on a
 * bare server, with a small `max` seam so the 429 path is reachable without
 * sending 1000+ requests. No database, no Redis, no trustProxy.
 */
async function buildIsolatedServer(options: {
  nodeEnv: NodeEnv;
  max?: number;
  timeWindow?: string | number;
  strictRoute?: { max: number; timeWindow: string } | undefined;
}): Promise<AppInstance> {
  const app = Fastify({ logger: false }) as unknown as AppInstance;
  await registerRequestId(app);
  await registerErrorHandler(app);
  await registerRateLimit(
    app,
    { nodeEnv: options.nodeEnv },
    { max: options.max ?? 2, timeWindow: options.timeWindow ?? "1 minute" },
  );
  app.get("/ping", async () => ({ ok: true }));
  if (options.strictRoute !== undefined) {
    const limit = options.strictRoute;
    app.post("/strict", { config: { rateLimit: { ...limit } } }, async () => ({
      ok: true,
    }));
  }
  return app;
}

async function get(
  app: AppInstance,
  url = "/ping",
): Promise<{
  statusCode: number;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}> {
  const response = await app.inject({ method: "GET", url });
  return {
    statusCode: response.statusCode,
    body: response.json(),
    headers: response.headers as Record<string, string | string[] | undefined>,
  };
}

describe("global rate-limit constants", () => {
  it("uses the coarse 1000 req / 60 s outer default", () => {
    expect(GLOBAL_RATE_LIMIT_MAX).toBe(1000);
    expect(GLOBAL_RATE_LIMIT_WINDOW).toBe("1 minute");
  });

  it("keeps strict route policies at their specified budgets", () => {
    expect(RATE_LIMIT_POLICIES.aiAnalysisCreate).toEqual({
      max: 10,
      timeWindow: "1 minute",
    });
    expect(RATE_LIMIT_POLICIES.reproductionCreate).toEqual({
      max: 20,
      timeWindow: "1 minute",
    });
    expect(RATE_LIMIT_POLICIES.secretTokenMutation).toEqual({
      max: 20,
      timeWindow: "1 minute",
    });
    expect(RATE_LIMIT_POLICIES.invitationMutation).toEqual({
      max: 30,
      timeWindow: "1 minute",
    });
    expect(RATE_LIMIT_POLICIES.cliArtifactUpload).toEqual({
      max: 30,
      timeWindow: "1 minute",
    });
    expect(RATE_LIMIT_POLICIES.issueMutation).toEqual({
      max: 60,
      timeWindow: "1 minute",
    });
  });
});

describe("global limiter behavior (non-test mode)", () => {
  it("lets requests below the limit succeed normally", async () => {
    const app = await buildIsolatedServer({ nodeEnv: "development" });
    try {
      expect((await get(app)).statusCode).toBe(200);
      const second = await get(app);
      expect(second.statusCode).toBe(200);
      expect(second.body).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("returns 429 once the limit is exceeded", async () => {
    const app = await buildIsolatedServer({ nodeEnv: "development" });
    try {
      expect((await get(app)).statusCode).toBe(200);
      expect((await get(app)).statusCode).toBe(200);
      expect((await get(app)).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("includes Retry-After on 429", async () => {
    const app = await buildIsolatedServer({ nodeEnv: "development" });
    try {
      await get(app);
      await get(app);
      const limited = await get(app);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("returns a safe envelope without limiter keys or credentials", async () => {
    const app = await buildIsolatedServer({ nodeEnv: "development" });
    try {
      await get(app);
      await get(app);
      const limited = await get(app);
      expect(limited.statusCode).toBe(429);
      const body = limited.body as Record<string, unknown>;
      expect(body["code"]).toBe("RATE_LIMITED");
      expect(body["message"]).toBe("Too many requests. Try again later.");
      expect(typeof body["requestId"]).toBe("string");
      expect(String(body["requestId"]).length).toBeGreaterThan(0);
      // The envelope correlates with the echoed request id header.
      expect(body["requestId"]).toBe(limited.headers["x-request-id"]);
      // No limiter internals or credentials leak into the body.
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "message",
        "requestId",
      ]);
      const serialized = JSON.stringify(body).toLowerCase();
      for (const leaked of [
        "127.0.0.1",
        "authorization",
        "cookie",
        "token",
        "session",
        "x-ratelimit",
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    } finally {
      await app.close();
    }
  });

  it("recovers after a controlled short window resets", async () => {
    const app = await buildIsolatedServer({
      nodeEnv: "development",
      max: 1,
      timeWindow: 500,
    });
    try {
      expect((await get(app)).statusCode).toBe(200);
      expect((await get(app)).statusCode).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect((await get(app)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("isolates buckets per observed client IP", async () => {
    const app = await buildIsolatedServer({
      nodeEnv: "development",
      max: 1,
    });
    try {
      expect((await get(app)).statusCode).toBe(200);
      expect((await get(app)).statusCode).toBe(429);
      // A different observed client IP uses a distinct limiter bucket
      // (via Fastify inject remote-address facilities; trustProxy stays off).
      const other = await app.inject({
        method: "GET",
        url: "/ping",
        remoteAddress: "9.9.9.9",
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("reaches a stricter route limit before the global 1000/min", async () => {
    const app = await buildIsolatedServer({
      nodeEnv: "development",
      max: GLOBAL_RATE_LIMIT_MAX,
      timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
      strictRoute: { max: 2, timeWindow: "1 minute" },
    });
    try {
      const post = async (): Promise<number> =>
        (await app.inject({ method: "POST", url: "/strict" })).statusCode;
      expect(await post()).toBe(200);
      expect(await post()).toBe(200);
      expect(await post()).toBe(429);
      // The global budget is untouched: ordinary routes still succeed.
      expect((await get(app)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("test-environment bypass", () => {
  it("does not consume or block normal test traffic in test mode", async () => {
    const app = await buildIsolatedServer({ nodeEnv: "test" });
    try {
      // max is 2, but test mode must never block.
      for (let i = 0; i < 6; i++) {
        expect((await get(app)).statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("keeps the real app wiring unblocked for test suites", async () => {
    const app = await buildApp({
      config: testApiConfig(),
      checkDatabase: async () => true,
    });
    try {
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: "GET",
          url: "/health/live",
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
