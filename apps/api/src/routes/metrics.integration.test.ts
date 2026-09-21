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
    payload: { email, password: PASSWORD, name: "Metrics Tester" },
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
    payload: { name: "Metrics WS" },
  });
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: "Metrics Proj" },
  });
  return {
    projectId: (projRes.json() as { project: { id: string } }).project.id,
  };
}

/**
 * Block 6 project metrics (T06) against real PostgreSQL: deterministic
 * fixtures, aggregated buckets, distributions, auth and tenant isolation.
 */
describe("project metrics integration (real PG)", () => {
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

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${randomUUID()}/metrics?range=24h`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns NOT_FOUND for unknown projects", async () => {
    const { cookies } = await signup(app, `m404-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${randomUUID()}/metrics?range=24h`,
      headers: { cookie: cookiesHeader(cookies) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("aggregates unresolved/new/occurrences/sessions/regressions/top/over-time/env/release", async () => {
    const { cookies } = await signup(app, `m-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie);

    const issueA = randomUUID();
    const issueB = randomUUID();
    const session1 = randomUUID();
    const session2 = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"a".repeat(64)}', 'sig', 'exception',
               'Alpha failure', 'Alpha failure', 'open', 'error',
               now() - interval '3 hours', now() - interval '1 hour', 3, 2),
              ($3, $2, '${"b".repeat(64)}', 'sig', 'network',
               'Beta timeout', 'Beta timeout', 'resolved', 'error',
               now() - interval '5 hours', now() - interval '2 hours', 1, 1)`,
      [issueA, projectId, issueB],
    );
    for (const [session, sdk] of [
      [session1, "sdk-1"],
      [session2, "sdk-2"],
    ] as const) {
      await dbClient.pool.query(
        `INSERT INTO telemetry_sessions
           ("id", "project_id", "sdk_session_id", "environment",
            "initial_url", "sdk_version")
         VALUES ($1, $2, $3, 'production', 'https://example.com/', 't@0')`,
        [session, projectId, sdk],
      );
    }
    const event = async (
      session: string,
      issue: string,
      env: string,
      release: string,
      hoursAgo: number,
    ): Promise<void> => {
      await dbClient.pool.query(
        `INSERT INTO events
           ("project_id", "telemetry_session_id", "client_event_id",
            "sequence_number", "event_type", "occurred_at",
            "environment", "release", "payload_json",
            "issue_id", "processing_state")
         VALUES ($1, $2, $3, 1, 'exception',
                 now() - ($4 || ' hours')::interval,
                 $5, $6, '{}'::jsonb, $7, 'processed')`,
        [
          projectId,
          session,
          randomUUID(),
          String(hoursAgo),
          env,
          release,
          issue,
        ],
      );
    };
    await event(session1, issueA, "production", "web@1.0.0", 1);
    await event(session1, issueA, "production", "web@1.0.0", 1);
    await event(session2, issueA, "staging", "web@1.0.1", 2);
    await event(session2, issueB, "production", "web@1.0.0", 2);
    await dbClient.pool.query(
      `INSERT INTO issue_activity ("issue_id", "actor_user_id", "type")
       VALUES ($1, NULL, 'regression_detected')`,
      [issueB],
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/metrics?range=24h`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      range: string;
      bucketSize: string;
      unresolvedCount: number;
      newIssueCount: number;
      occurrenceCount: number;
      affectedSessionCount: number;
      regressionCount: number;
      topIssues: Array<{ issueId: string; occurrences: number }>;
      overTime: Array<{
        bucketStart: string;
        occurrences: number;
        newIssues: number;
      }>;
      byEnvironment: Array<{ key: string; occurrences: number }>;
      byRelease: Array<{ key: string; occurrences: number }>;
    };

    expect(body.range).toBe("24h");
    expect(body.bucketSize).toBe("hourly");
    expect(body.unresolvedCount).toBe(1);
    expect(body.newIssueCount).toBe(2);
    expect(body.occurrenceCount).toBe(4);
    expect(body.affectedSessionCount).toBe(2);
    expect(body.regressionCount).toBe(1);

    expect(body.topIssues[0]).toMatchObject({
      issueId: issueA,
      occurrences: 3,
    });
    expect(body.topIssues[1]).toMatchObject({
      issueId: issueB,
      occurrences: 1,
    });

    // 24 hourly UTC buckets covering the range.
    expect(body.overTime).toHaveLength(24);
    const totalOccurrences = body.overTime.reduce(
      (sum, b) => sum + b.occurrences,
      0,
    );
    expect(totalOccurrences).toBe(4);
    const totalNew = body.overTime.reduce((sum, b) => sum + b.newIssues, 0);
    expect(totalNew).toBe(2);

    const env = new Map(body.byEnvironment.map((e) => [e.key, e.occurrences]));
    expect(env.get("production")).toBe(3);
    expect(env.get("staging")).toBe(1);
    const rel = new Map(body.byRelease.map((e) => [e.key, e.occurrences]));
    expect(rel.get("web@1.0.0")).toBe(3);
    expect(rel.get("web@1.0.1")).toBe(1);
  });

  it("uses daily buckets for 7d and rejects bad ranges", async () => {
    const { cookies } = await signup(app, `mr-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie);

    const week = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/metrics?range=7d`,
      headers: { cookie },
    });
    expect(week.statusCode).toBe(200);
    const body = week.json() as {
      bucketSize: string;
      overTime: unknown[];
      unresolvedCount: number;
    };
    expect(body.bucketSize).toBe("daily");
    expect(body.overTime).toHaveLength(7);
    expect(body.unresolvedCount).toBe(0);

    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/metrics?range=90d`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
