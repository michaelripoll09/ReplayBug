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
    payload: { email, password: PASSWORD, name: "Session Tester" },
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

/** Inserts a session + ordered events; returns ids. */
async function seedSession(
  dbClient: DbClient,
  projectId: string,
  opts: {
    sdk: string;
    environment: string;
    release: string | null;
    lastSeenHoursAgo: number;
    events: Array<{
      seq: number;
      type: string;
      env?: string;
      payload?: Record<string, unknown>;
      issueId?: string | null;
      hoursAgo?: number;
    }>;
  },
): Promise<{ sessionId: string; eventIds: string[] }> {
  const sessionId = randomUUID();
  await dbClient.pool.query(
    `INSERT INTO telemetry_sessions
       ("id", "project_id", "sdk_session_id", "environment", "release",
        "initial_url", "sdk_version", "started_at", "last_seen_at")
     VALUES ($1, $2, $3, $4, $5, 'https://example.com/', 't@0',
             now() - ($6 || ' hours')::interval,
             now() - ($6 || ' hours')::interval)`,
    [
      sessionId,
      projectId,
      opts.sdk,
      opts.environment,
      opts.release,
      String(opts.lastSeenHoursAgo),
    ],
  );
  const eventIds: string[] = [];
  for (const e of opts.events) {
    const id = randomUUID();
    eventIds.push(id);
    await dbClient.pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "page_url", "payload_json",
          "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, $5, $6,
               now() - ($7 || ' hours')::interval,
               $8, $9, 'https://example.com/', $10, $11, 'processed')`,
      [
        id,
        projectId,
        sessionId,
        randomUUID(),
        e.seq,
        e.type,
        String(e.hoursAgo ?? opts.lastSeenHoursAgo),
        e.env ?? opts.environment,
        opts.release,
        JSON.stringify(e.payload ?? {}),
        e.issueId ?? null,
      ],
    );
  }
  return { sessionId, eventIds };
}

/**
 * Block 6 sessions API + timeline context (T10) on real PG: filters,
 * ordering, bounded pagination, host-ID-free DTOs and sequence windows.
 */
describe("sessions integration (real PG)", () => {
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

  async function setup(): Promise<{
    cookie: string;
    projectId: string;
    sessionA: string;
    sessionB: string;
    issueId: string;
    errorEventId: string;
  }> {
    const { cookies } = await signup(
      app,
      `s-${Date.now()}-${Math.random()}@example.com`,
    );
    const cookie = cookiesHeader(cookies);
    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: "Sess WS" },
    });
    const workspaceId = (wsRes.json() as { id: string }).id;
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: { cookie },
      payload: { name: "Sess Proj" },
    });
    const projectId = (projRes.json() as { project: { id: string } }).project
      .id;

    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"a".repeat(64)}', 'sig', 'exception',
               'Session failure', 'Session failure', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId],
    );

    const eventsA = [];
    for (let seq = 1; seq <= 30; seq += 1) {
      if (seq === 25) {
        eventsA.push({
          seq,
          type: "exception",
          payload: { values: [{ type: "TypeError", value: "boom" }] },
          issueId,
        });
      } else if (seq % 5 === 0) {
        eventsA.push({
          seq,
          type: "click",
          payload: { element_tag: "button", locator_candidates: [] },
        });
      } else {
        eventsA.push({
          seq,
          type: "navigation",
          payload: { to_url: "https://example.com/" },
        });
      }
    }
    const a = await seedSession(dbClient, projectId, {
      sdk: "sdk-a",
      environment: "production",
      release: "web@1.0.0",
      lastSeenHoursAgo: 1,
      events: eventsA,
    });
    const b = await seedSession(dbClient, projectId, {
      sdk: "sdk-b",
      environment: "staging",
      release: "web@1.0.1",
      lastSeenHoursAgo: 5,
      events: [{ seq: 1, type: "navigation", payload: {} }],
    });
    return {
      cookie,
      projectId,
      sessionA: a.sessionId,
      sessionB: b.sessionId,
      issueId,
      errorEventId: a.eventIds[24] as string,
    };
  }

  it("requires authentication across session routes", async () => {
    const id = randomUUID();
    for (const url of [
      `/api/v1/projects/${id}/sessions`,
      `/api/v1/sessions/${id}`,
      `/api/v1/sessions/${id}/events`,
      `/api/v1/events/${id}/timeline-context`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("lists sessions newest-first without host identifiers", async () => {
    const { cookie, projectId, sessionA, sessionB } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sessions`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; environment: string }>;
      nextCursor?: string;
    };
    expect(body.items.map((i) => i.id)).toEqual([sessionA, sessionB]);
    expect(body.nextCursor).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sdk-a");
    for (const item of body.items) {
      expect(item).not.toHaveProperty("sdkSessionId");
      expect(item).not.toHaveProperty("anonymousUserHash");
    }

    const prod = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sessions?environment=production`,
      headers: { cookie },
    });
    expect(
      (prod.json() as { items: Array<{ id: string }> }).items.map((i) => i.id),
    ).toEqual([sessionA]);

    const errors = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sessions?hasErrors=true`,
      headers: { cookie },
    });
    expect(
      (errors.json() as { items: Array<{ id: string }> }).items.map(
        (i) => i.id,
      ),
    ).toEqual([sessionA]);

    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sessions?limit=1`,
      headers: { cookie },
    });
    const p1 = page1.json() as { items: unknown[]; nextCursor?: string };
    expect(p1.items).toHaveLength(1);
    expect(typeof p1.nextCursor).toBe("string");
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/sessions?limit=1&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
      headers: { cookie },
    });
    expect(
      (page2.json() as { items: Array<{ id: string }> }).items.map((i) => i.id),
    ).toEqual([sessionB]);
  });

  it("returns session detail and hides cross-tenant sessions", async () => {
    const { cookie, sessionA } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionA}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: sessionA,
      environment: "production",
      release: "web@1.0.0",
    });

    const stranger = await signup(app, `sstr-${Date.now()}@example.com`);
    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionA}`,
      headers: { cookie: cookiesHeader(stranger.cookies) },
    });
    expect(denied.statusCode).toBe(404);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${randomUUID()}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists session events in sequence order with summaries, bounded", async () => {
    const { cookie, sessionA } = await setup();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionA}/events?limit=5`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        sequenceNumber: number;
        eventType: string;
        summary: string;
      }>;
      nextCursor?: string;
    };
    expect(body.items.map((i) => i.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(typeof body.nextCursor).toBe("string");
    for (const item of body.items) {
      expect(typeof item.summary).toBe("string");
      expect(item).not.toHaveProperty("payload_json");
      expect(item).not.toHaveProperty("payloadJson");
    }

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionA}/events?limit=30&cursor=${encodeURIComponent(body.nextCursor as string)}`,
      headers: { cookie },
    });
    const p2 = page2.json() as {
      items: Array<{ sequenceNumber: number }>;
      nextCursor?: string;
    };
    expect(p2.items.map((i) => i.sequenceNumber)[0]).toBe(6);
    expect(p2.items).toHaveLength(25);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("returns sequence-based timeline context with defaults and bounds", async () => {
    const { cookie, errorEventId, sessionA } = await setup();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/events/${errorEventId}/timeline-context`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessionId: string;
      anchor: { eventId: string; sequenceNumber: number };
      before: Array<{ sequenceNumber: number }>;
      after: Array<{ sequenceNumber: number }>;
    };
    expect(body.sessionId).toBe(sessionA);
    expect(body.anchor.sequenceNumber).toBe(25);
    // Default 20 before / 5 after.
    expect(body.before.map((e) => e.sequenceNumber)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 5),
    );
    expect(body.after.map((e) => e.sequenceNumber)).toEqual([
      26, 27, 28, 29, 30,
    ]);

    const custom = await app.inject({
      method: "GET",
      url: `/api/v1/events/${errorEventId}/timeline-context?before=2&after=1`,
      headers: { cookie },
    });
    const cbody = custom.json() as {
      before: Array<{ sequenceNumber: number }>;
      after: Array<{ sequenceNumber: number }>;
    };
    expect(cbody.before.map((e) => e.sequenceNumber)).toEqual([23, 24]);
    expect(cbody.after.map((e) => e.sequenceNumber)).toEqual([26]);

    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/events/${errorEventId}/timeline-context?before=500`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
