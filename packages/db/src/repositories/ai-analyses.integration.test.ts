import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "./db-types.js";
import {
  createAiAnalysisRequest,
  findAiAnalysisByIdInIssue,
  listIssueAiAnalyses,
  markAiAnalysisReady,
} from "./ai-analyses.js";
import { createIsolatedTestDatabase } from "../test-support/isolated-test-database.js";

const HASH = "a".repeat(64);
let db: Database;
let pool: Pool;
let cleanup: (() => Promise<void>) | undefined;

interface Fixture {
  userId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  eventId: string;
}

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await pool.query(sql, params);
}

async function countRows(
  table: "ai_analyses" | "ai_analysis_outbox",
  where: "id" | "issue_id" | "analysis_id",
  value: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where} = $1`,
    [value],
  );
  return result.rows[0]?.count ?? 0;
}

async function createFixture(): Promise<Fixture> {
  const ownerId = `owner-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const sessionId = randomUUID();
  const eventId = randomUUID();
  await exec(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner', $2)`, [
    ownerId,
    `${ownerId}@example.com`,
  ]);
  await exec(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Analyst', $2)`,
    [userId, `${userId}@example.com`],
  );
  await exec(
    `INSERT INTO workspaces (id, name, slug, created_by_user_id) VALUES ($1, 'AI WS', $2, $3)`,
    [workspaceId, `ai-${workspaceId.slice(0, 8)}`, ownerId],
  );
  await exec(
    `INSERT INTO projects (id, workspace_id, name, slug) VALUES ($1, $2, 'AI Project', $3)`,
    [projectId, workspaceId, `ai-${projectId.slice(0, 8)}`],
  );
  await exec(
    `INSERT INTO issues (id, project_id, fingerprint, fingerprint_signature, type, title, normalized_message, severity, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'signature', 'exception', 'Boom', 'Boom', 'error', now(), now())`,
    [issueId, projectId, "f".repeat(64)],
  );
  await exec(
    `INSERT INTO telemetry_sessions (id, project_id, sdk_session_id, environment, initial_url, sdk_version)
     VALUES ($1, $2, $3, 'test', 'https://example.test', '1.0.0')`,
    [sessionId, projectId, `sdk-${sessionId}`],
  );
  await exec(
    `INSERT INTO events (id, project_id, telemetry_session_id, client_event_id, sequence_number, event_type, occurred_at, environment, payload_json)
     VALUES ($1, $2, $3, $4, 1, 'exception', now(), 'test', '{}'::jsonb)`,
    [eventId, projectId, sessionId, `event-${eventId}`],
  );
  return { userId, workspaceId, projectId, issueId, eventId };
}

beforeAll(async () => {
  const isolated = await createIsolatedTestDatabase({ suite: "ai-analysis" });
  db = isolated.client.db;
  pool = isolated.client.pool;
  cleanup = isolated.cleanup;
});

afterAll(async () => {
  await cleanup?.();
});

describe("AI analysis repository (real PostgreSQL)", () => {
  it("creates one pending analysis and one durable outbox row for same-key retries", async () => {
    const fixture = await createFixture();
    const input = {
      issueId: fixture.issueId,
      eventId: fixture.eventId,
      requestedByUserId: fixture.userId,
      model: "qwen2.5:7b",
      analysisVersion: "1.0.0",
      idempotencyKeyHash: HASH,
    };
    const first = await createAiAnalysisRequest(db, input);
    const second = await createAiAnalysisRequest(db, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await countRows("ai_analyses", "issue_id", fixture.issueId)).toBe(1);
    expect(
      await countRows("ai_analysis_outbox", "analysis_id", first.row.id),
    ).toBe(1);
  });

  it("keeps terminal analyses immutable and paginates within their issue", async () => {
    const fixture = await createFixture();
    const created = await createAiAnalysisRequest(db, {
      issueId: fixture.issueId,
      eventId: fixture.eventId,
      requestedByUserId: fixture.userId,
      model: "qwen2.5:7b",
      analysisVersion: "1.0.0",
      idempotencyKeyHash: "b".repeat(64),
    });
    const result = {
      summary: "A stale checkout state causes the exception.",
      suspectedCause: "The renewal callback races with submit.",
      evidence: [{ ref: "stack:1", reason: "The frame enters renewal." }],
      reproductionSteps: ["Open checkout", "Submit after renewal"],
      limitations: ["No server trace is retained."],
    };
    const first = await db.transaction((tx) =>
      markAiAnalysisReady(tx, created.row.id, result),
    );
    const second = await db.transaction((tx) =>
      markAiAnalysisReady(tx, created.row.id, result),
    );

    expect(first?.status).toBe("ready");
    expect(second).toBeUndefined();
    const listed = await listIssueAiAnalyses(db, {
      issueId: fixture.issueId,
      limit: 10,
    });
    expect(listed.rows.map((row) => row.id)).toContain(created.row.id);
  });

  it("retains analysis history when its event or requester is deleted", async () => {
    const fixture = await createFixture();
    const created = await createAiAnalysisRequest(db, {
      issueId: fixture.issueId,
      eventId: fixture.eventId,
      requestedByUserId: fixture.userId,
      model: "qwen2.5:7b",
      analysisVersion: "1.0.0",
      idempotencyKeyHash: "c".repeat(64),
    });
    await exec(`DELETE FROM events WHERE id = $1`, [fixture.eventId]);
    await exec(`DELETE FROM "user" WHERE id = $1`, [fixture.userId]);

    const found = await findAiAnalysisByIdInIssue(
      db,
      fixture.issueId,
      created.row.id,
    );
    expect(found?.eventId).toBeNull();
    expect(found?.requestedByUserId).toBeNull();
  });

  it("cascades analyses and their outbox rows when the issue project is deleted", async () => {
    const fixture = await createFixture();
    const created = await createAiAnalysisRequest(db, {
      issueId: fixture.issueId,
      eventId: fixture.eventId,
      requestedByUserId: fixture.userId,
      model: "qwen2.5:7b",
      analysisVersion: "1.0.0",
      idempotencyKeyHash: "d".repeat(64),
    });
    await exec(`DELETE FROM projects WHERE id = $1`, [fixture.projectId]);

    expect(await countRows("ai_analyses", "id", created.row.id)).toBe(0);
    expect(
      await countRows("ai_analysis_outbox", "analysis_id", created.row.id),
    ).toBe(0);
  });
});
