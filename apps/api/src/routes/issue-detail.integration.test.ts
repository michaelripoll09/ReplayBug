import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

async function signup(
  app: AppInstance,
  email: string,
): Promise<{ cookies: string[] }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Detail Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  return {
    cookies: Array.isArray(raw)
      ? (raw as string[])
      : raw !== undefined
        ? [String(raw)]
        : [],
  };
}

async function createWorkspaceAndProject(
  app: AppInstance,
  cookie: string,
): Promise<{ projectId: string }> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: "Detail WS" },
  });
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: "Detail Proj" },
  });
  return {
    projectId: (projRes.json() as { project: { id: string } }).project.id,
  };
}

const EXCEPTION_PAYLOAD = {
  values: [
    {
      type: "TypeError",
      value: "Cannot read properties of null",
      stacktrace: {
        frames: [
          {
            filename: "https://example.com/app.js",
            function: "onClick",
            lineno: 42,
            colno: 7,
            in_app: true,
          },
        ],
      },
      mechanism: { type: "onerror", handled: false, data: { secret: "x" } },
    },
  ],
  mechanism: { type: "onerror", handled: false },
  fingerprint: ["custom-override-should-never-leak"],
};

/**
 * Block 6 issue detail, occurrences and event detail (T07) on real PG:
 * auth, tenant isolation, DTO shapes without payload/fingerprint leaks,
 * per-type sanitized event evidence.
 */
describe("issue detail integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  async function seed(): Promise<{
    cookie: string;
    projectId: string;
    issueId: string;
    eventId: string;
    sessionId: string;
  }> {
    const { cookies } = await signup(
      app,
      `d-${Date.now()}-${Math.random()}@example.com`,
    );
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie);
    const issueId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"d".repeat(64)}', 'sig', 'exception',
               'TypeError: boom', 'TypeError: boom', 'investigating', 'error',
               now() - interval '2 hours', now() - interval '1 hour', 2, 1)`,
      [issueId, projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, 'sdk-detail', 'production',
               'https://example.com/checkout', 't@0')`,
      [sessionId, projectId],
    );
    const insertEvent = async (id: string, hoursAgo: number): Promise<void> => {
      await dbClient.pool.query(
        `INSERT INTO events
           ("id", "project_id", "telemetry_session_id", "client_event_id",
            "sequence_number", "event_type", "occurred_at",
            "environment", "release", "page_url", "payload_json",
            "issue_id", "processing_state")
         VALUES ($1, $2, $3, $4, 1, 'exception',
                 now() - ($5 || ' hours')::interval,
                 'production', 'web@2.0.0', 'https://example.com/checkout',
                 $6, $7, 'processed')`,
        [
          id,
          projectId,
          sessionId,
          randomUUID(),
          String(hoursAgo),
          EXCEPTION_PAYLOAD,
          issueId,
        ],
      );
    };
    await insertEvent(eventId, 1);
    await insertEvent(randomUUID(), 2);
    return { cookie, projectId, issueId, eventId, sessionId };
  }

  it("requires authentication for detail, occurrences and event", async () => {
    const id = randomUUID();
    for (const url of [
      `/api/v1/issues/${id}`,
      `/api/v1/issues/${id}/occurrences`,
      `/api/v1/events/${id}`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("returns NOT_FOUND for unknown ids", async () => {
    const { cookies } = await signup(app, `d404-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const id = randomUUID();
    for (const url of [
      `/api/v1/issues/${id}`,
      `/api/v1/issues/${id}/occurrences`,
      `/api/v1/events/${id}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("hides cross-tenant issues and events as NOT_FOUND", async () => {
    const a = await signup(app, `dx-a-${Date.now()}@example.com`);
    const b = await signup(app, `dx-b-${Date.now()}@example.com`);
    const seeded = await seed();
    void a;
    const otherCookie = cookiesHeader(b.cookies);
    // Re-seed under B? No: seeded project belongs to A's flow (seed() signs
    // up its own owner). B must not see it.
    for (const url of [
      `/api/v1/issues/${seeded.issueId}`,
      `/api/v1/events/${seeded.eventId}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie: otherCookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("returns issue detail without fingerprint material or payloads", async () => {
    const { cookie, issueId } = await seed();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: issueId,
      type: "exception",
      title: "TypeError: boom",
      status: "investigating",
    });
    expect(body).not.toHaveProperty("fingerprint");
    expect(body).not.toHaveProperty("fingerprintSignature");
    expect(body).not.toHaveProperty("payload_json");
    expect(body).not.toHaveProperty("payloadJson");
    expect(body).toHaveProperty("tags");
  });

  it("paginates occurrences newest-first without full payloads", async () => {
    const { cookie, issueId, eventId, sessionId } = await seed();
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/occurrences?limit=1`,
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json() as {
      items: Array<{
        eventId: string;
        sessionId: string;
        eventType: string;
        environment: string;
        release: string;
        pageUrl: string;
        processingState: string;
      }>;
      nextCursor?: string;
    };
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]).toMatchObject({
      eventId,
      sessionId,
      eventType: "exception",
      environment: "production",
      release: "web@2.0.0",
      pageUrl: "https://example.com/checkout",
      processingState: "processed",
    });
    expect(p1.items[0]).not.toHaveProperty("payload_json");
    expect(p1.items[0]).not.toHaveProperty("payloadJson");
    expect(typeof p1.nextCursor).toBe("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/occurrences?limit=1&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
      headers: { cookie },
    });
    const p2 = page2.json() as { items: unknown[]; nextCursor?: string };
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("returns sanitized per-type event evidence", async () => {
    const { cookie, eventId, sessionId, issueId } = await seed();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/events/${eventId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      eventId: string;
      sessionId: string;
      issueId: string;
      eventType: string;
      data: {
        values: Array<{
          type: string;
          value: string;
          stacktrace?: {
            frames: Array<{
              filename: string;
              function: string;
              lineno: number;
            }>;
          };
        }>;
      };
    };
    expect(body).toMatchObject({ eventId, sessionId, issueId });
    expect(body.eventType).toBe("exception");
    expect(body.data.values[0]).toMatchObject({
      type: "TypeError",
      value: "Cannot read properties of null",
    });
    expect(body.data.values[0]?.stacktrace?.frames[0]).toMatchObject({
      filename: "https://example.com/app.js",
      function: "onClick",
      lineno: 42,
    });
    // Mechanism internals and fingerprint overrides never leak.
    expect(JSON.stringify(body)).not.toContain(
      "custom-override-should-never-leak",
    );
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
