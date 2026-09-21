import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

interface Seed {
  cookie: string;
  userId: string;
  projectId: string;
  issueId: string;
  eventId: string;
  sessionId: string;
}

async function signup(
  app: AppInstance,
  email: string,
): Promise<{ cookies: string[]; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "AI Tester" },
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

async function seed(
  app: AppInstance,
  dbClient: DbClient,
  tag: string,
): Promise<Seed> {
  const { cookies, userId } = await signup(
    app,
    `ai-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  );
  const cookie = cookiesHeader(cookies);
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: `AI WS ${tag}` },
  });
  expect(wsRes.statusCode).toBe(201);
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: `AI Proj ${tag}` },
  });
  expect(projRes.statusCode).toBe(201);
  const projectId = (projRes.json() as { project: { id: string } }).project.id;

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
  await dbClient.pool.query(
    `INSERT INTO events
       ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at",
        "environment", "release", "page_url", "payload_json",
        "issue_id", "processing_state")
     VALUES ($1, $2, $3, $4, 1, 'exception', now() - interval '1 hour',
             'production', 'demo@1.0.0', 'https://demo.test/checkout', $5::jsonb,
             $6, 'processed')`,
    [
      eventId,
      projectId,
      sessionId,
      randomUUID(),
      JSON.stringify({
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of null (reading 'checkout')",
            stacktrace: { frames: [] },
          },
        ],
      }),
      issueId,
    ],
  );
  return { cookie, userId, projectId, issueId, eventId, sessionId };
}

async function postAiAnalysis(
  app: AppInstance,
  cookie: string,
  eventId: string,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/events/${eventId}/ai-analyses`,
    headers: { cookie, "Idempotency-Key": key },
    payload: {},
  });
  return {
    status: res.statusCode,
    body: res.json() as Record<string, unknown>,
  };
}

function configuredConfig() {
  return testApiConfig({
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "llama3.2",
    aiAnalysis: {
      status: "configured",
      configured: true,
      model: "llama3.2",
    },
  });
}

function disabledConfig() {
  return testApiConfig({
    aiAnalysis: { status: "disabled", configured: false },
  });
}

function misconfiguredUrlOnlyConfig() {
  return testApiConfig({
    ollamaUrl: "http://localhost:11434",
    aiAnalysis: { status: "misconfigured", configured: false },
  });
}

/**
 * Block 10 AI analysis API integration on real PG:
 * request idempotency, history, detail, RBAC, tenancy, degraded operation,
 * retention survival, project cascade.
 */
describe("ai-analyses integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: configuredConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("creates a pending analysis and returns 202", async () => {
    const s = await seed(app, dbClient, "happy");
    const key = randomUUID();
    const { status, body } = await postAiAnalysis(
      app,
      s.cookie,
      s.eventId,
      key,
    );
    expect(status).toBe(202);
    expect(body).toMatchObject({
      issueId: s.issueId,
      eventId: s.eventId,
      status: "pending",
    });
    const analysisId = body["id"] as string;
    const rows = await dbClient.pool.query(
      `SELECT * FROM ai_analyses WHERE id = $1`,
      [analysisId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]["status"]).toBe("pending");
    expect(rows.rows[0]["model"]).toBe("llama3.2");
    expect(rows.rows[0]["analysis_version"]).toBe("1.0.0");
    expect(rows.rows[0]["requested_by_user_id"]).toBe(s.userId);
    expect(rows.rows[0]["idempotency_key_hash"]).toMatch(/^[0-9a-f]{64}$/);

    const outbox = await dbClient.pool.query(
      `SELECT * FROM ai_analysis_outbox WHERE analysis_id = $1`,
      [analysisId],
    );
    expect(outbox.rowCount).toBe(1);

    const activity = await dbClient.pool.query(
      `SELECT * FROM issue_activity WHERE issue_id = $1 AND type = 'ai_analysis_requested'`,
      [s.issueId],
    );
    expect(activity.rowCount).toBe(1);
    const meta = activity.rows[0]["metadata_json"] as Record<string, unknown>;
    expect(meta["analysisId"]).toBe(analysisId);
    expect(meta["eventId"]).toBe(s.eventId);
    expect(meta["model"]).toBe("llama3.2");
    expect(meta["analysisVersion"]).toBe("1.0.0");
  });

  it("returns 200 for the same idempotency key without creating orphans", async () => {
    const s = await seed(app, dbClient, "dedup");
    const key = randomUUID();
    const first = await postAiAnalysis(app, s.cookie, s.eventId, key);
    expect(first.status).toBe(202);
    const second = await postAiAnalysis(app, s.cookie, s.eventId, key);
    expect(second.status).toBe(200);
    expect(second.body["id"]).toBe(first.body["id"]);

    const count = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
      [s.issueId],
    );
    expect(count.rows[0]["c"]).toBe(1);
    const outboxCount = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analysis_outbox WHERE analysis_id = $1`,
      [first.body["id"]],
    );
    expect(outboxCount.rows[0]["c"]).toBe(1);
    const activityCount = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM issue_activity WHERE issue_id = $1 AND type = 'ai_analysis_requested'`,
      [s.issueId],
    );
    expect(activityCount.rows[0]["c"]).toBe(1);
  });

  it("serializes concurrent same-key requests into one row", async () => {
    const s = await seed(app, dbClient, "concurrent");
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        postAiAnalysis(app, s.cookie, s.eventId, key),
      ),
    );
    const ids = new Set(results.map((r) => r.body["id"]));
    expect(ids.size).toBe(1);
    expect(results.some((r) => r.status === 202)).toBe(true);
    expect(
      results.filter((r) => r.status === 200).length,
    ).toBeGreaterThanOrEqual(4);

    const count = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
      [s.issueId],
    );
    expect(count.rows[0]["c"]).toBe(1);
    const outboxCount = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analysis_outbox WHERE analysis_id = $1`,
      [Array.from(ids)[0]],
    );
    expect(outboxCount.rows[0]["c"]).toBe(1);
    const activityCount = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM issue_activity WHERE issue_id = $1 AND type = 'ai_analysis_requested'`,
      [s.issueId],
    );
    expect(activityCount.rows[0]["c"]).toBe(1);
  });

  it("creates a second analysis for a new idempotency key", async () => {
    const s = await seed(app, dbClient, "again");
    const first = await postAiAnalysis(app, s.cookie, s.eventId, randomUUID());
    expect(first.status).toBe(202);
    const second = await postAiAnalysis(app, s.cookie, s.eventId, randomUUID());
    expect(second.status).toBe(202);
    expect(second.body["id"]).not.toBe(first.body["id"]);

    const count = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
      [s.issueId],
    );
    expect(count.rows[0]["c"]).toBe(2);
  });

  it("rejects viewer POST with 403 but allows GET history", async () => {
    const s = await seed(app, dbClient, "rbac");
    const viewerUser = await signup(
      app,
      `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    );
    const wsId = await app
      .inject({
        method: "GET",
        url: "/api/v1/workspaces",
        headers: { cookie: s.cookie },
      })
      .then((r) => (r.json() as { id: string }[])[0]!.id);
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId: wsId,
      userId: viewerUser.userId,
      role: "viewer",
    });
    const viewerCookie = cookiesHeader(viewerUser.cookies);

    const post = await postAiAnalysis(
      app,
      viewerCookie,
      s.eventId,
      randomUUID(),
    );
    expect(post.status).toBe(403);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${s.issueId}/ai-analyses`,
      headers: { cookie: viewerCookie },
    });
    expect(history.statusCode).toBe(200);
  });

  it("returns 404 for a cross-tenant event", async () => {
    const s1 = await seed(app, dbClient, "tenant-a");
    const s2 = await seed(app, dbClient, "tenant-b");
    const res = await postAiAnalysis(app, s1.cookie, s2.eventId, randomUUID());
    expect(res.status).toBe(404);
  });

  it("rejects requests when AI is disabled with AI_NOT_CONFIGURED and no rows", async () => {
    const disabledApp = await buildApp({
      config: disabledConfig(),
      dbClient,
    });
    try {
      await resetTestDatabase(dbClient);
      const s = await seed(disabledApp, dbClient, "disabled");
      const res = await postAiAnalysis(
        disabledApp,
        s.cookie,
        s.eventId,
        randomUUID(),
      );
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("AI_NOT_CONFIGURED");

      const count = await dbClient.pool.query(
        `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
        [s.issueId],
      );
      expect(count.rows[0]["c"]).toBe(0);
      const activityCount = await dbClient.pool.query(
        `SELECT COUNT(*)::int AS c FROM issue_activity WHERE issue_id = $1 AND type = 'ai_analysis_requested'`,
        [s.issueId],
      );
      expect(activityCount.rows[0]["c"]).toBe(0);
    } finally {
      await disabledApp.close();
    }
  });

  it("rejects requests when AI is misconfigured with AI_NOT_CONFIGURED", async () => {
    const misconfApp = await buildApp({
      config: misconfiguredUrlOnlyConfig(),
      dbClient,
    });
    try {
      await resetTestDatabase(dbClient);
      const s = await seed(misconfApp, dbClient, "misconf");
      const res = await postAiAnalysis(
        misconfApp,
        s.cookie,
        s.eventId,
        randomUUID(),
      );
      expect(res.status).toBe(503);
      expect(res.body["code"]).toBe("AI_NOT_CONFIGURED");

      const count = await dbClient.pool.query(
        `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
        [s.issueId],
      );
      expect(count.rows[0]["c"]).toBe(0);
    } finally {
      await misconfApp.close();
    }
  });

  it("requires a non-empty Idempotency-Key header", async () => {
    const s = await seed(app, dbClient, "no-key");
    const missing = await app.inject({
      method: "POST",
      url: `/api/v1/events/${s.eventId}/ai-analyses`,
      headers: { cookie: s.cookie },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/events/${s.eventId}/ai-analyses`,
      headers: { cookie: s.cookie, "Idempotency-Key": "" },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it("lists paginated history without raw evidence", async () => {
    const s = await seed(app, dbClient, "history");
    await postAiAnalysis(app, s.cookie, s.eventId, randomUUID());
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${s.issueId}/ai-analyses?limit=1`,
      headers: { cookie: s.cookie },
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as {
      items: Array<{
        id: string;
        eventId: string | null;
        model: string;
        status: string;
        analysisVersion: string;
        requestedBy: { id: string; email: string; name: string } | null;
        createdAt: string;
        completedAt: string | null;
      }>;
      nextCursor?: string;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.model).toBe("llama3.2");
    expect(body.items[0]!.status).toBe("pending");
    expect(body.items[0]!.requestedBy?.id).toBe(s.userId);
    expect(body.items[0]).not.toHaveProperty("summary");
    expect(body.items[0]).not.toHaveProperty("evidence");
  });

  it("returns detail with validated output or safe failure fields", async () => {
    const s = await seed(app, dbClient, "detail");
    const created = await postAiAnalysis(
      app,
      s.cookie,
      s.eventId,
      randomUUID(),
    );
    const analysisId = created.body["id"] as string;

    await dbClient.pool.query(
      `UPDATE ai_analyses
       SET status = 'ready',
           summary = 'A summary',
           suspected_cause = 'A cause',
           evidence_json = $2::jsonb,
           reproduction_steps_json = $3::jsonb,
           limitations_json = $4::jsonb,
           completed_at = now()
       WHERE id = $1`,
      [
        analysisId,
        JSON.stringify([{ ref: "event/exception", reason: "It failed" }]),
        JSON.stringify(["Open the page", "Click checkout"]),
        JSON.stringify(["Local state may differ"]),
      ],
    );

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ai-analyses/${analysisId}`,
      headers: { cookie: s.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      id: string;
      summary: string | null;
      suspectedCause: string | null;
      evidence: Array<{ ref: string; reason: string }> | null;
      reproductionSteps: string[] | null;
      limitations: string[] | null;
      errorCode: string | null;
      errorMessage: string | null;
    };
    expect(body.summary).toBe("A summary");
    expect(body.suspectedCause).toBe("A cause");
    expect(body.evidence).toEqual([
      { ref: "event/exception", reason: "It failed" },
    ]);
    expect(body.reproductionSteps).toEqual(["Open the page", "Click checkout"]);
    expect(body.limitations).toEqual(["Local state may differ"]);
    expect(body.errorCode).toBeNull();
    expect(body.errorMessage).toBeNull();
  });

  it("returns detail with safe failure fields for failed analyses", async () => {
    const s = await seed(app, dbClient, "failed");
    const created = await postAiAnalysis(
      app,
      s.cookie,
      s.eventId,
      randomUUID(),
    );
    const analysisId = created.body["id"] as string;

    await dbClient.pool.query(
      `UPDATE ai_analyses
       SET status = 'failed',
           error_code = 'PROVIDER_UNAVAILABLE',
           error_message = 'The provider could not be reached',
           completed_at = now()
       WHERE id = $1`,
      [analysisId],
    );

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ai-analyses/${analysisId}`,
      headers: { cookie: s.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      status: string;
      summary: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    };
    expect(body.status).toBe("failed");
    expect(body.summary).toBeNull();
    expect(body.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(body.errorMessage).toBe("The provider could not be reached");
  });

  it("survives source event deletion with null eventId and safe reads", async () => {
    const s = await seed(app, dbClient, "retention");
    const created = await postAiAnalysis(
      app,
      s.cookie,
      s.eventId,
      randomUUID(),
    );
    const analysisId = created.body["id"] as string;

    await dbClient.pool.query(`DELETE FROM events WHERE id = $1`, [s.eventId]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/ai-analyses/${analysisId}`,
      headers: { cookie: s.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { eventId: string | null };
    expect(body.eventId).toBeNull();

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${s.issueId}/ai-analyses`,
      headers: { cookie: s.cookie },
    });
    expect(history.statusCode).toBe(200);
    const hist = history.json() as { items: Array<{ eventId: string | null }> };
    expect(hist.items[0]!.eventId).toBeNull();
  });

  it("cascades AI rows when the project is deleted", async () => {
    const s = await seed(app, dbClient, "cascade");
    await postAiAnalysis(app, s.cookie, s.eventId, randomUUID());

    const before = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
      [s.issueId],
    );
    expect(before.rows[0]["c"]).toBe(1);

    await dbClient.pool.query(`DELETE FROM projects WHERE id = $1`, [
      s.projectId,
    ]);

    const after = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS c FROM ai_analyses WHERE issue_id = $1`,
      [s.issueId],
    );
    expect(after.rows[0]["c"]).toBe(0);
  });

  it("exposes safe capability state without URL or env values", async () => {
    const s = await seed(app, dbClient, "capability");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meta/ai-analysis",
      headers: { cookie: s.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      aiAnalysis: {
        configured: boolean;
        status: string;
        model?: string;
        url?: string;
      };
    };
    expect(body.aiAnalysis.configured).toBe(true);
    expect(body.aiAnalysis.status).toBe("configured");
    expect(body.aiAnalysis.model).toBe("llama3.2");
    expect(body.aiAnalysis.url).toBeUndefined();
  });
});
