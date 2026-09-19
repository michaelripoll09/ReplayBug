import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReproductionRepo, type DbClient } from "@replaybug/db";
import { REPRODUCTION_GENERATOR_VERSION } from "@replaybug/reproducer";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";
import { processGenerateReproduction } from "../../../worker/src/processors/generate-reproduction.js";

const PASSWORD = "TestPass123!";
const BASE_URL = "https://demo.test";

async function signup(
  app: AppInstance,
  email: string,
): Promise<{ cookies: string[]; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Repro Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : raw !== undefined
      ? [String(raw)]
      : [];
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: cookiesHeader(cookies) },
  });
  const body = me.json() as { id?: string; user?: { id?: string } };
  const userId = body.id ?? body.user?.id ?? "";
  return { cookies, userId };
}

interface Seed {
  cookie: string;
  userId: string;
  projectId: string;
  issueId: string;
  eventId: string;
  sessionId: string;
}

const EXCEPTION_PAYLOAD = {
  values: [
    {
      type: "TypeError",
      value: "Cannot read properties of null (reading 'checkout')",
      stacktrace: { frames: [] },
    },
  ],
};

const CLICK_PAYLOAD = {
  locator_candidates: [
    { type: "test_id", value: "checkout-button", confidence: 1.0 },
  ],
  element_tag: "button",
  element_role: "button",
  accessible_name: "Checkout",
  route: "/checkout",
};

const NAV_PAYLOAD = (to: string): Record<string, unknown> => ({
  from_url: "https://demo.test/",
  to_url: to,
  navigation_type: "pushState",
});

/**
 * Block 8 reproduction API integration on real PG:
 * request idempotency, history, deterministic failures, RBAC, privacy,
 * download safety, immutability, cross-tenant anti-enumeration.
 */
describe("reproductions integration (real PG)", () => {
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

  async function seed(tag: string): Promise<Seed> {
    const { cookies, userId } = await signup(
      app,
      `repro-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    );
    const cookie = cookiesHeader(cookies);
    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: `Repro WS ${tag}` },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie },
      payload: { name: `Repro Proj ${tag}` },
    });
    expect(projRes.statusCode).toBe(201);
    const projectId = (projRes.json() as { project: { id: string } }).project
      .id;

    // Configure the production environment base URL directly.
    await dbClient.pool.query(
      `UPDATE project_environments SET base_url = $2 WHERE project_id = $1 AND name = 'production'`,
      [projectId, BASE_URL],
    );

    const issueId = randomUUID();
    const sessionId = randomUUID();
    const eventId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint", "fingerprint_signature",
         "type", "title", "normalized_message", "status", "severity",
         "first_seen_at", "last_seen_at", "occurrence_count", "affected_session_count")
       VALUES ($1, $2, $3, 'sig', 'exception', 'TypeError: checkout', 'TypeError: checkout',
               'open', 'error', now() - interval '2 hours', now() - interval '1 hour', 1, 1)`,
      [issueId, projectId, `${"e".repeat(63)}${String(tag.length % 10)}`],
    );
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
       VALUES ($1, $2, $3, 'production', 'https://demo.test/', 't@0')`,
      [sessionId, projectId, `sdk-${tag}-${Date.now()}`],
    );
    const insertEvent = async (
      id: string,
      seq: number,
      type: string,
      payload: unknown,
      pageUrl: string,
    ): Promise<void> => {
      await dbClient.pool.query(
        `INSERT INTO events
           ("id", "project_id", "telemetry_session_id", "client_event_id",
            "sequence_number", "event_type", "occurred_at",
            "environment", "release", "page_url", "payload_json",
            "issue_id", "processing_state")
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour' + ($10 || ' seconds')::interval,
                 'production', 'demo@1.0.0', $7, $8::jsonb, $9, 'processed')`,
        [
          id,
          projectId,
          sessionId,
          randomUUID(),
          seq,
          type,
          pageUrl,
          JSON.stringify(payload),
          type === "exception" ? issueId : null,
          String(seq),
        ],
      );
    };
    await insertEvent(
      randomUUID(),
      1,
      "navigation",
      NAV_PAYLOAD("https://demo.test/checkout"),
      "https://demo.test/checkout",
    );
    await insertEvent(
      randomUUID(),
      2,
      "click",
      CLICK_PAYLOAD,
      "https://demo.test/checkout",
    );
    await insertEvent(
      eventId,
      3,
      "exception",
      EXCEPTION_PAYLOAD,
      "https://demo.test/checkout",
    );
    return { cookie, userId, projectId, issueId, eventId, sessionId };
  }

  async function postRepro(
    cookie: string,
    eventId: string,
    key: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/events/${eventId}/reproductions`,
      headers: { cookie, "Idempotency-Key": key },
      payload: {},
    });
    return {
      status: res.statusCode,
      body: res.json() as Record<string, unknown>,
    };
  }

  async function runWorker(reproductionId: string): Promise<void> {
    await processGenerateReproduction({ db: dbClient.db }, { reproductionId });
  }

  it("creates pending reproduction and generates ready code via worker", async () => {
    const s = await seed("happy");
    const { status, body } = await postRepro(s.cookie, s.eventId, randomUUID());
    expect(status).toBe(202);
    expect(body).toMatchObject({
      issueId: s.issueId,
      eventId: s.eventId,
      status: "pending",
    });
    const reproductionId = body["id"] as string;

    // Outbox row exists and undispatched.
    const outbox = await dbClient.pool.query(
      `SELECT * FROM reproduction_generation_outbox WHERE reproduction_id = $1`,
      [reproductionId],
    );
    expect(outbox.rowCount).toBe(1);

    await runWorker(reproductionId);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/reproductions/${reproductionId}`,
      headers: { cookie: s.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const dto = detail.json() as Record<string, unknown>;
    expect(dto["status"]).toBe("ready");
    expect(dto["generatorVersion"]).toBe(REPRODUCTION_GENERATOR_VERSION);
    const code = dto["code"] as string;
    expect(code).toContain(`import { test, expect } from '@playwright/test';`);
    expect(code).toContain(`getByTestId('checkout-button')`);
    expect(code).toContain(`page.on('pageerror'`);
    expect(code).toContain(REPRODUCTION_GENERATOR_VERSION);

    // Activity recorded exactly once.
    const activity = await dbClient.pool.query(
      `SELECT * FROM issue_activity WHERE issue_id = $1 AND type = 'reproduction_generated'`,
      [s.issueId],
    );
    expect(activity.rowCount).toBe(1);
  });

  it("deduplicates concurrent same Idempotency-Key requests", async () => {
    const s = await seed("idem");
    const key = randomUUID();
    const results = await Promise.all([
      postRepro(s.cookie, s.eventId, key),
      postRepro(s.cookie, s.eventId, key),
      postRepro(s.cookie, s.eventId, key),
    ]);
    const ids = results.map((r) => r.body["id"] as string);
    expect(new Set(ids).size).toBe(1);
    // First is 202, rest are 200 deduplicated.
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);

    const count = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM reproduction_tests WHERE event_id = $1`,
      [s.eventId],
    );
    expect(count.rows[0]?.["n"]).toBe(1);

    await runWorker(ids[0] as string);
    const activity = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM issue_activity WHERE issue_id = $1 AND type = 'reproduction_generated'`,
      [s.issueId],
    );
    expect(activity.rows[0]?.["n"]).toBe(1);
  });

  it("regenerate creates new immutable history row", async () => {
    const s = await seed("regen");
    const first = await postRepro(s.cookie, s.eventId, randomUUID());
    const second = await postRepro(s.cookie, s.eventId, randomUUID());
    expect(first.body["id"]).not.toBe(second.body["id"]);
    await runWorker(first.body["id"] as string);
    const codeBefore = (
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/reproductions/${first.body["id"] as string}`,
          headers: { cookie: s.cookie },
        })
      ).json() as Record<string, unknown>
    )["code"];
    await runWorker(second.body["id"] as string);
    const codeAfter = (
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/reproductions/${first.body["id"] as string}`,
          headers: { cookie: s.cookie },
        })
      ).json() as Record<string, unknown>
    )["code"];
    expect(codeAfter).toBe(codeBefore);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${s.issueId}/reproductions?limit=10`,
      headers: { cookie: s.cookie },
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: unknown[] }).items;
    expect(items).toHaveLength(2);
    // List summaries carry no code.
    for (const item of items) {
      expect(item).not.toHaveProperty("code");
    }
  });

  it("second worker run is a no-op (retry idempotency)", async () => {
    const s = await seed("retry");
    const { body } = await postRepro(s.cookie, s.eventId, randomUUID());
    const id = body["id"] as string;
    await runWorker(id);
    await runWorker(id);
    const activity = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM issue_activity WHERE issue_id = $1 AND type = 'reproduction_generated'`,
      [s.issueId],
    );
    expect(activity.rows[0]?.["n"]).toBe(1);
    const row = await ReproductionRepo.findReproductionById(dbClient.db, id);
    expect(row?.status).toBe("ready");
  });

  it("rejects unsupported failure without orphan pending rows", async () => {
    const s = await seed("unsup");
    // Replace exception payload with a message event (unsupported).
    const msgId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO events ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at", "environment",
        "page_url", "payload_json", "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 9, 'message', now(), 'production',
               'https://demo.test/', $5::jsonb, $6, 'processed')`,
      [
        msgId,
        s.projectId,
        s.sessionId,
        randomUUID(),
        JSON.stringify({ message: "hello", level: "info" }),
        s.issueId,
      ],
    );
    const before = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM reproduction_tests`,
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/events/${msgId}/reproductions`,
      headers: { cookie: s.cookie, "Idempotency-Key": randomUUID() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as Record<string, unknown>)["code"]).toBe(
      "REPRODUCTION_UNSUPPORTED_FAILURE",
    );
    const after = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM reproduction_tests`,
    );
    expect(after.rows[0]?.["n"]).toBe(before.rows[0]?.["n"]);
  });

  it("requires base URL and creates no orphan job", async () => {
    const s = await seed("nobase");
    await dbClient.pool.query(
      `UPDATE project_environments SET base_url = NULL WHERE project_id = $1`,
      [s.projectId],
    );
    const before = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM reproduction_tests`,
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/events/${s.eventId}/reproductions`,
      headers: { cookie: s.cookie, "Idempotency-Key": randomUUID() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as Record<string, unknown>)["code"]).toBe(
      "REPRODUCTION_BASE_URL_REQUIRED",
    );
    const after = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS n FROM reproduction_tests`,
    );
    expect(after.rows[0]?.["n"]).toBe(before.rows[0]?.["n"]);
  });

  it("enforces cross-tenant anti-enumeration", async () => {
    const s = await seed("tenant");
    const other = await signup(app, `other-${Date.now()}@example.com`);
    const otherCookie = cookiesHeader(other.cookies);
    const post = await app.inject({
      method: "POST",
      url: `/api/v1/events/${s.eventId}/reproductions`,
      headers: { cookie: otherCookie, "Idempotency-Key": randomUUID() },
      payload: {},
    });
    expect(post.statusCode).toBe(404);
    for (const url of [
      `/api/v1/issues/${s.issueId}/reproductions`,
      `/api/v1/reproductions/${(await postRepro(s.cookie, s.eventId, randomUUID())).body["id"] as string}`,
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie: otherCookie },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("viewer can read but cannot generate", async () => {
    const s = await seed("viewer");
    const { body } = await postRepro(s.cookie, s.eventId, randomUUID());
    const reproId = body["id"] as string;
    await runWorker(reproId);

    const viewer = await signup(app, `viewer-${Date.now()}@example.com`);
    // Attach viewer to the same workspace as viewer role.
    const wsId = (
      await dbClient.pool.query(
        `SELECT workspace_id FROM projects WHERE id = $1`,
        [s.projectId],
      )
    ).rows[0]?.["workspace_id"] as string;
    await dbClient.pool.query(
      `INSERT INTO workspace_memberships ("workspace_id", "user_id", "role")
       VALUES ($1, $2, 'viewer')`,
      [wsId, viewer.userId],
    );
    const viewerCookie = cookiesHeader(viewer.cookies);

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/events/${s.eventId}/reproductions`,
      headers: { cookie: viewerCookie, "Idempotency-Key": randomUUID() },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/reproductions/${reproId}`,
      headers: { cookie: viewerCookie },
    });
    expect(readable.statusCode).toBe(200);

    const dl = await app.inject({
      method: "GET",
      url: `/api/v1/reproductions/${reproId}/download`,
      headers: { cookie: viewerCookie },
    });
    expect(dl.statusCode).toBe(200);
  });

  it("privacy sweep: secrets never appear in generated code", async () => {
    const s = await seed("priv");
    const evil =
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummy-signature-value-here";
    await dbClient.pool.query(
      `INSERT INTO events ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at", "environment",
        "page_url", "payload_json", "processing_state")
       VALUES ($1, $2, $3, $4, 4, 'input', now(), 'production',
               'https://demo.test/login', $5::jsonb, 'processed')`,
      [
        randomUUID(),
        s.projectId,
        s.sessionId,
        randomUUID(),
        JSON.stringify({
          input_type: "password",
          input_name: "password",
          has_value: true,
          value: evil,
          is_safe_selector_match: true,
        }),
      ],
    );
    // New occurrence after the secret input.
    const evilEvent = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO events ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at", "environment",
        "page_url", "payload_json", "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 5, 'exception', now(), 'production',
               'https://demo.test/login', $5::jsonb, $6, 'processed')`,
      [
        evilEvent,
        s.projectId,
        s.sessionId,
        randomUUID(),
        JSON.stringify(EXCEPTION_PAYLOAD),
        s.issueId,
      ],
    );
    const { body } = await postRepro(s.cookie, evilEvent, randomUUID());
    await runWorker(body["id"] as string);
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/v1/reproductions/${body["id"] as string}`,
        headers: { cookie: s.cookie },
      })
    ).json() as Record<string, unknown>;
    const code = detail["code"] as string;
    expect(code).not.toContain("eyJhbGciOi");
    expect(code).not.toContain("Bearer");
    expect(code).toContain("REPLACE_WITH_TEST_VALUE");
    expect(detail["hasRedactedSteps"]).toBe(true);
  });

  it("download is exact, safe filename and headers", async () => {
    const s = await seed("dl");
    const evilTitle = "x\r\nContent-Type: evil";
    await dbClient.pool.query(`UPDATE issues SET title = $2 WHERE id = $1`, [
      s.issueId,
      evilTitle,
    ]);
    const { body } = await postRepro(s.cookie, s.eventId, randomUUID());
    await runWorker(body["id"] as string);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reproductions/${body["id"] as string}/download`,
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toContain("attachment");
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).toMatch(/replaybug-[0-9a-f]{8}-[0-9a-f]{8}\.spec\.ts/);
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/v1/reproductions/${body["id"] as string}`,
        headers: { cookie: s.cookie },
      })
    ).json() as Record<string, unknown>;
    expect(res.body).toBe(detail["code"]);
  });
});
