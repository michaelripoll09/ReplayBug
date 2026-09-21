import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveAnonymousUserHash, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";
const CONFIGURED_ORIGIN = "http://localhost:5173";

const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BEARER_SECRET = "rb_test_bearer_token_abcdefghijklmnop";
const API_SECRET = "sk_live_0123456789abcdef";
const PASSWORD_SECRET = "Sup3rSecretPassword";
const URL_SECRET = "url-leak-secret-123456";
const CARD_SECRET = "4111111111111111";

interface ProjectFixture {
  projectId: string;
  publicKey: string;
  cookies: string;
}

function makeEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: randomUUID(),
    sequence_number: 0,
    event_type: "console_error",
    timestamp: new Date().toISOString(),
    payload: { args: ["DEMO: intentional failure"] },
    ...overrides,
  };
}

function makeBatch(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol_version: 1,
    sdk_name: "@replaybug/sdk",
    sdk_version: "0.2.0",
    session: {
      sdk_session_id: randomUUID(),
      browser: {
        name: "chromium",
        version: "120.0",
        os_name: "Windows",
        os_version: "11",
        device_type: "desktop",
        viewport_width: 1280,
        viewport_height: 720,
      },
      initial_url: `${CONFIGURED_ORIGIN}/`,
      environment: "test",
      release: "test@0.0.1",
    },
    events: [makeEvent()],
    ...overrides,
  };
}

describe("Block 4 ingest integration (real PG)", () => {
  let app: AppInstance;
  let appLowRateLimit: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
    appLowRateLimit = await buildApp({
      config: testApiConfig({
        ingestRateLimitRequestsPerMinute: 3,
        ingestRateLimitEventsPerMinute: 100,
      }),
      dbClient,
    });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await appLowRateLimit.close();
    await dbClient.close();
  });

  async function signup(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: PASSWORD, name: "Tester" },
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
    }
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return cookiesHeader(cookies);
  }

  /**
   * Creates a real user + workspace + project through the public API and
   * returns the one-time plaintext bootstrap key plus the configured origin.
   */
  async function createProject(options?: {
    addOrigin?: string | null;
    target?: AppInstance;
  }): Promise<ProjectFixture> {
    const target = options?.target ?? app;
    const cookie = await signup(`ingest-${randomUUID()}@example.com`);

    const wsRes = await target.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: `Ingest WS ${randomUUID().slice(0, 8)}` },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };

    const projRes = await target.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie },
      payload: { name: `Ingest Proj ${randomUUID().slice(0, 8)}` },
    });
    expect(projRes.statusCode).toBe(201);
    const created = projRes.json() as {
      project: { id: string };
      bootstrap: { key: string };
    };

    const origin =
      options?.addOrigin === undefined ? CONFIGURED_ORIGIN : options.addOrigin;
    if (origin !== null) {
      const originRes = await target.inject({
        method: "POST",
        url: `/api/v1/projects/${created.project.id}/origins`,
        headers: { cookie },
        payload: { origin },
      });
      expect(originRes.statusCode).toBe(201);
    }

    return {
      projectId: created.project.id,
      publicKey: created.bootstrap.key,
      cookies: cookie,
    };
  }

  async function ingest(
    fixture: ProjectFixture,
    batch: Record<string, unknown>,
    options?: {
      key?: string;
      origin?: string | null;
      target?: AppInstance;
    },
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const target = options?.target ?? app;
    const headers: Record<string, string> = {
      "x-replaybug-key": options?.key ?? fixture.publicKey,
    };
    const origin =
      options?.origin === undefined ? CONFIGURED_ORIGIN : options.origin;
    if (origin !== null) {
      headers["origin"] = origin;
    }
    const res = await target.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers,
      payload: batch,
    });
    return { statusCode: res.statusCode, body: res.json() ?? {} };
  }

  async function countRows(table: string, projectId: string): Promise<number> {
    const res = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE project_id = $1`,
      [projectId],
    );
    return (res.rows[0] as { count: number }).count;
  }

  /** Serialized persisted telemetry used for leak scanning. */
  async function persistedTelemetryJson(projectId: string): Promise<string> {
    const sessions = await dbClient.pool.query(
      `SELECT row_to_json(t) AS row FROM telemetry_sessions t WHERE project_id = $1`,
      [projectId],
    );
    const events = await dbClient.pool.query(
      `SELECT row_to_json(t) AS row FROM events t WHERE project_id = $1`,
      [projectId],
    );
    return JSON.stringify([...sessions.rows, ...events.rows]);
  }

  // ---------------------------------------------------------------- happy path

  it("accepts a valid batch and persists session, event and outbox as pending", async () => {
    const fixture = await createProject();
    const batch = makeBatch();
    const session = batch["session"] as Record<string, unknown>;
    const sdkSessionId = session["sdk_session_id"] as string;

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      accepted: 1,
      duplicate: 0,
      rejected: 0,
    });
    expect(typeof res.body["requestId"]).toBe("string");

    const sessions = await dbClient.pool.query(
      `SELECT * FROM telemetry_sessions WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(sessions.rows.length).toBe(1);
    expect(sessions.rows[0].sdk_session_id).toBe(sdkSessionId);
    expect(sessions.rows[0].browser_name).toBe("chromium");
    expect(sessions.rows[0].environment).toBe("test");
    expect(sessions.rows[0].release).toBe("test@0.0.1");

    const eventsRes = await dbClient.pool.query(
      `SELECT * FROM events WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(eventsRes.rows.length).toBe(1);
    expect(eventsRes.rows[0].processing_state).toBe("pending");
    expect(eventsRes.rows[0].telemetry_session_id).toBe(sessions.rows[0].id);

    const outbox = await dbClient.pool.query(
      `SELECT o.* FROM event_processing_outbox o
       JOIN events e ON e.id = o.event_id
       WHERE e.project_id = $1`,
      [fixture.projectId],
    );
    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].dispatched_at).toBeNull();
    expect(outbox.rows[0].attempt_count).toBe(0);
  });

  // ---------------------------------------------------------------------- HMAC

  it("derives anonymous_user_hash and never persists the raw user ID", async () => {
    const fixture = await createProject();
    const rawUserId = `synthetic-user-${randomUUID()}`;
    const batch = makeBatch({
      session: {
        ...(makeBatch()["session"] as Record<string, unknown>),
        user_id: rawUserId,
      },
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1 });

    const sessions = await dbClient.pool.query(
      `SELECT anonymous_user_hash FROM telemetry_sessions WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(sessions.rows.length).toBe(1);
    const hash = sessions.rows[0].anonymous_user_hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const expected = deriveAnonymousUserHash({
      projectId: fixture.projectId,
      rawUserId,
      secret: testApiConfig().userHmacSecret,
    });
    expect(hash).toBe(expected);

    // Raw ID must not appear anywhere in persisted telemetry.
    const persisted = await persistedTelemetryJson(fixture.projectId);
    expect(persisted).not.toContain(rawUserId);
  });

  // --------------------------------------------------------------- idempotency

  it("is idempotent for sequential duplicate submissions", async () => {
    const fixture = await createProject();
    const batch = makeBatch(); // same event_id + session on both submissions

    const first = await ingest(fixture, batch);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({
      accepted: 1,
      duplicate: 0,
      rejected: 0,
    });

    const second = await ingest(fixture, batch);
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({
      accepted: 0,
      duplicate: 1,
      rejected: 0,
    });

    expect(await countRows("events", fixture.projectId)).toBe(1);
    const outbox = await dbClient.pool.query(
      `SELECT o.* FROM event_processing_outbox o
       JOIN events e ON e.id = o.event_id WHERE e.project_id = $1`,
      [fixture.projectId],
    );
    expect(outbox.rows.length).toBe(1);
  });

  it("is idempotent under concurrent duplicate submissions", async () => {
    const fixture = await createProject();
    const batch = makeBatch();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ingest(fixture, batch)),
    );

    for (const result of results) {
      expect(result.statusCode).toBe(200);
    }
    const accepted = results.reduce(
      (sum, r) => sum + Number(r.body["accepted"] ?? 0),
      0,
    );
    const rejected = results.reduce(
      (sum, r) => sum + Number(r.body["rejected"] ?? 0),
      0,
    );
    expect(accepted).toBe(1);
    expect(rejected).toBe(0);

    expect(await countRows("events", fixture.projectId)).toBe(1);
    const outbox = await dbClient.pool.query(
      `SELECT o.* FROM event_processing_outbox o
       JOIN events e ON e.id = o.event_id WHERE e.project_id = $1`,
      [fixture.projectId],
    );
    expect(outbox.rows.length).toBe(1);
  });

  // -------------------------------------------------------------------- origin

  it("enforces exact origin matching", async () => {
    const fixture = await createProject();

    const allowed = await ingest(fixture, makeBatch());
    expect(allowed.statusCode).toBe(200);

    const rejectedOrigins = [
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "https://localhost:5173",
      "http://evil.localhost:5173",
    ];
    for (const origin of rejectedOrigins) {
      const res = await ingest(fixture, makeBatch(), { origin });
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: "DISALLOWED_ORIGIN" });
    }

    // Missing origin header is also rejected.
    const noOrigin = await ingest(fixture, makeBatch(), { origin: null });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.body).toMatchObject({ code: "DISALLOWED_ORIGIN" });

    // Only the accepted request produced telemetry.
    expect(await countRows("events", fixture.projectId)).toBe(1);
  });

  it("rejects disabled origins, cross-project origins and subdomain lookalikes", async () => {
    const fixture = await createProject();
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/origins`,
      headers: { cookie: fixture.cookies },
      payload: { origin: "https://app.example.com" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/origins`,
      headers: { cookie: fixture.cookies },
      payload: { origin: "http://disabled.example.com" },
    });
    await dbClient.pool.query(
      `UPDATE project_origins SET is_enabled = false
       WHERE project_id = $1 AND origin = 'http://disabled.example.com'`,
      [fixture.projectId],
    );

    // Cross-project: another project with its own, different origin.
    const other = await createProject({ addOrigin: "http://localhost:6000" });
    const cross = await ingest(fixture, makeBatch(), {
      origin: "http://localhost:6000",
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.body).toMatchObject({ code: "DISALLOWED_ORIGIN" });
    void other;

    // Subdomain lookalike of a configured origin.
    const subdomain = await ingest(fixture, makeBatch(), {
      origin: "https://evil.app.example.com",
    });
    expect(subdomain.statusCode).toBe(403);
    expect(subdomain.body).toMatchObject({ code: "DISALLOWED_ORIGIN" });

    // Disabled origin.
    const disabled = await ingest(fixture, makeBatch(), {
      origin: "http://disabled.example.com",
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.body).toMatchObject({ code: "DISALLOWED_ORIGIN" });

    // Exact configured origin still works.
    const exact = await ingest(fixture, makeBatch(), {
      origin: "https://app.example.com",
    });
    expect(exact.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------- CORS

  it("answers preflight only with credential-less ingest CORS headers", async () => {
    const fixture = await createProject();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/ingest/v1/batch",
      headers: {
        origin: CONFIGURED_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-replaybug-key",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(String(res.headers["access-control-allow-headers"])).toContain(
      "Content-Type",
    );
    expect(String(res.headers["access-control-allow-headers"])).toContain(
      "X-ReplayBug-Key",
    );
    expect(String(res.headers["access-control-allow-methods"])).toContain(
      "POST",
    );
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    void fixture;
  });

  it("grants ingest CORS read permission only after origin validation", async () => {
    const fixture = await createProject();

    // Allowed origin: readable response, no credentials, no cookie required.
    const allowed = await app.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: {
        "x-replaybug-key": fixture.publicKey,
        origin: CONFIGURED_ORIGIN,
      },
      payload: makeBatch(),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("*");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();

    // Disallowed origin: no CORS read permission on the rejection.
    const denied = await app.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: {
        "x-replaybug-key": fixture.publicKey,
        origin: "http://evil.example.com",
      },
      payload: makeBatch(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  // ---------------------------------------------------------------- rate limit

  it("enforces rate limits with Retry-After and atomic bucket counters", async () => {
    const fixture = await createProject({ target: appLowRateLimit });

    for (let i = 0; i < 3; i++) {
      const res = await ingest(fixture, makeBatch(), {
        target: appLowRateLimit,
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await appLowRateLimit.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: {
        "x-replaybug-key": fixture.publicKey,
        origin: CONFIGURED_ORIGIN,
      },
      payload: makeBatch(),
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // The SDK must be able to read the 429 to honor Retry-After.
    expect(limited.headers["access-control-allow-origin"]).toBe("*");

    const buckets = await dbClient.pool.query(
      `SELECT * FROM rate_limit_buckets WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(buckets.rows.length).toBe(1);
    expect(buckets.rows[0].request_count).toBe(4);
    expect(buckets.rows[0].event_count).toBe(4);
  });

  it("counts concurrent requests atomically at the rate limit boundary", async () => {
    const fixture = await createProject({ target: appLowRateLimit });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        appLowRateLimit.inject({
          method: "POST",
          url: "/api/ingest/v1/batch",
          headers: {
            "x-replaybug-key": fixture.publicKey,
            origin: CONFIGURED_ORIGIN,
          },
          payload: makeBatch(),
        }),
      ),
    );

    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);

    const buckets = await dbClient.pool.query(
      `SELECT * FROM rate_limit_buckets WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(buckets.rows[0].request_count).toBe(6);
    expect(await countRows("events", fixture.projectId)).toBe(3);
  });

  // ------------------------------------------------------------ payload limits

  it("enforces batch size limits (50 allowed, 51 rejected)", async () => {
    const fixture = await createProject();

    const fifty = makeBatch({
      events: Array.from({ length: 50 }, (_, i) =>
        makeEvent({ sequence_number: i }),
      ),
    });
    const ok = await ingest(fixture, fifty);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatchObject({ accepted: 50 });

    const fiftyOne = makeBatch({
      events: Array.from({ length: 51 }, (_, i) =>
        makeEvent({ sequence_number: i }),
      ),
    });
    const tooMany = await ingest(fixture, fiftyOne);
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("enforces the body size limit with 413 PAYLOAD_TOO_LARGE", async () => {
    const fixture = await createProject();

    const oversized = makeBatch({
      session: {
        ...(makeBatch()["session"] as Record<string, unknown>),
        tags: { pad: "x".repeat(530000) },
      },
    });
    const res = await ingest(fixture, oversized);
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("enforces the per-event size limit with deterministic rejection", async () => {
    const fixture = await createProject();

    const oversizedEvent = makeBatch({
      events: [makeEvent({ payload: { message: "x".repeat(140000) } })],
    });
    const res = await ingest(fixture, oversizedEvent);
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    const nearLimit = makeBatch({
      events: [makeEvent({ payload: { message: "y".repeat(60000) } })],
    });
    const ok = await ingest(fixture, nearLimit);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatchObject({ accepted: 1 });
  });

  it("truncates messages beyond 8 KB deterministically", async () => {
    const fixture = await createProject();
    const batch = makeBatch({
      events: [makeEvent({ payload: { message: "m".repeat(9000) } })],
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1 });

    const stored = await dbClient.pool.query(
      `SELECT payload_json->>'message' AS message FROM events WHERE project_id = $1`,
      [fixture.projectId],
    );
    const message = stored.rows[0].message as string;
    expect(message.length).toBeLessThan(9000);
    expect(message.endsWith("…")).toBe(true);
  });

  it("truncates stack frames to the maximum of 100", async () => {
    const fixture = await createProject();
    const frames = Array.from({ length: 101 }, (_, i) => ({
      filename: `frame-${i}.js`,
      function: "fn",
      lineno: i + 1,
    }));
    const batch = makeBatch({
      events: [
        makeEvent({
          event_type: "exception",
          payload: {
            values: [{ type: "Error", value: "boom", stacktrace: { frames } }],
          },
        }),
      ],
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);

    const stored = await dbClient.pool.query(
      `SELECT jsonb_array_length(payload_json->'values'->0->'stacktrace'->'frames') AS count
       FROM events WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(stored.rows[0].count).toBe(100);
  });

  it("accepts batches with 51 breadcrumbs and deep context deterministically", async () => {
    const fixture = await createProject();
    const breadcrumbs = Array.from({ length: 51 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      type: "custom",
      message: `crumb-${i}`,
      level: "info",
    }));
    const deepContext = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: "deep" } } } } } } },
    };
    const batch = makeBatch({
      events: [
        makeEvent({
          event_type: "exception",
          breadcrumbs,
          context: deepContext,
          payload: { values: [{ type: "Error", value: "boom" }] },
        }),
      ],
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1, rejected: 0 });
  });

  it("rejects unsupported protocol versions with a machine-readable code", async () => {
    const fixture = await createProject();
    const batch = makeBatch({ protocol_version: 2 });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "UNSUPPORTED_PROTOCOL_VERSION" });
  });

  it("rejects invalid event types with a machine-readable code", async () => {
    const fixture = await createProject();
    const batch = makeBatch({
      events: [makeEvent({ event_type: "totally_bogus" })],
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "UNSUPPORTED_EVENT_TYPE" });
  });

  // ---------------------------------------------------------------- key model

  it("accepts a project-created key immediately and rejects it after rotation", async () => {
    const fixture = await createProject();

    const withBootstrap = await ingest(fixture, makeBatch());
    expect(withBootstrap.statusCode).toBe(200);

    const rotate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/keys/public/rotate`,
      headers: { cookie: fixture.cookies },
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = rotate.json() as { key: string };

    const withOldKey = await ingest(fixture, makeBatch(), {
      key: fixture.publicKey,
    });
    expect(withOldKey.statusCode).toBe(401);
    expect(withOldKey.body).toMatchObject({ code: "REVOKED_PUBLIC_KEY" });

    const withNewKey = await ingest(fixture, makeBatch(), {
      key: rotated.key,
    });
    expect(withNewKey.statusCode).toBe(200);
    expect(withNewKey.body).toMatchObject({ accepted: 1 });
  });

  it("rejects missing or malformed keys", async () => {
    const fixture = await createProject();

    const noKey = await app.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: { origin: CONFIGURED_ORIGIN },
      payload: makeBatch(),
    });
    expect(noKey.statusCode).toBe(401);
    expect(noKey.json()).toMatchObject({ code: "INVALID_PUBLIC_KEY" });

    const badKey = await ingest(fixture, makeBatch(), {
      key: "rb_pk_deadbeef_not-a-real-key",
    });
    expect(badKey.statusCode).toBe(401);
  });

  // ------------------------------------------------------ malicious client

  it("redacts secrets from hostile clients that bypass the SDK", async () => {
    const fixture = await createProject();
    const batch = makeBatch({
      session: {
        ...(makeBatch()["session"] as Record<string, unknown>),
        initial_url: `${CONFIGURED_ORIGIN}/checkout?token=${URL_SECRET}`,
      },
      events: [
        makeEvent({
          event_type: "exception",
          context: {
            password: PASSWORD_SECRET,
            nested: { api_key: API_SECRET },
            note: `Authorization: Bearer ${BEARER_SECRET}`,
          },
          payload: {
            values: [
              {
                type: "Error",
                value: `Authorization: Bearer ${JWT_FIXTURE}`,
              },
            ],
            api_key: API_SECRET,
            nested: { password: PASSWORD_SECRET },
            page_url: `${CONFIGURED_ORIGIN}/checkout?token=${URL_SECRET}`,
            note: `card ${CARD_SECRET} provided`,
          },
        }),
      ],
    });

    const res = await ingest(fixture, batch);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: 1 });

    const persisted = await persistedTelemetryJson(fixture.projectId);
    for (const secret of [
      JWT_FIXTURE,
      BEARER_SECRET,
      API_SECRET,
      PASSWORD_SECRET,
      URL_SECRET,
      CARD_SECRET,
    ]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED]");

    // The sanitized page_url column must not leak the query secret either.
    const eventsRes = await dbClient.pool.query(
      `SELECT page_url FROM events WHERE project_id = $1`,
      [fixture.projectId],
    );
    expect(String(eventsRes.rows[0].page_url)).not.toContain(URL_SECRET);
  });
});
