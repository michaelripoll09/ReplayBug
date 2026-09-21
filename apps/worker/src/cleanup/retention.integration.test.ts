import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupRateLimitBuckets,
  upsertTelemetrySession,
  type DbClient,
} from "@replaybug/db";
import { runExpiredInvitationCleanup } from "./invitations.js";
import {
  runRetentionCleanup,
  startRetentionCleanupRunner,
} from "./retention.js";
import {
  createTestLogger,
  createWorkerTestDatabase,
  insertTestEvent,
  seedProject,
  waitFor,
  type SeededProject,
  type WorkerTestDatabase,
} from "../test-helpers.js";

interface EventStateRow {
  id: string;
  processing_state: string;
  issue_id: string | null;
}

interface EventOutboxRow {
  event_id: string;
  dispatched_at: Date | null;
}

interface IssueSnapshot {
  occurrence_count: number;
  affected_session_count: number;
  status: string;
  last_seen_at: Date;
}

interface ReproductionSnapshot {
  id: string;
  event_id: string | null;
  status: string;
  code: string | null;
  generator_version: string;
}

interface CountRow {
  count: string;
}

let testDb: WorkerTestDatabase;
let client: DbClient;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
});

afterAll(async () => {
  await testDb.drop();
});

async function rows<T>(query: string, values: unknown[] = []): Promise<T[]> {
  const result = await client.pool.query(query, values);
  return result.rows as T[];
}

async function setRetentionDays(
  projectId: string,
  retentionDays: number,
): Promise<void> {
  await client.pool.query(
    "UPDATE projects SET retention_days = $2 WHERE id = $1",
    [projectId, retentionDays],
  );
}

async function markEventProcessed(
  eventId: string,
  processingState: "processed" | "rejected",
  dispatched = true,
  issueId: string | null = null,
): Promise<void> {
  await client.pool.query(
    `UPDATE events
     SET processing_state = $2::processing_state,
         rejection_reason = CASE WHEN $2 = 'rejected' THEN 'test_rejection' ELSE NULL END,
         issue_id = $3
     WHERE id = $1`,
    [eventId, processingState, issueId],
  );
  if (dispatched) {
    await client.pool.query(
      "UPDATE event_processing_outbox SET dispatched_at = $2 WHERE event_id = $1",
      [eventId, new Date("2026-09-20T00:00:00.000Z")],
    );
  }
}

async function readEvent(eventId: string): Promise<EventStateRow | undefined> {
  const result = await rows<EventStateRow>(
    "SELECT id, processing_state, issue_id FROM events WHERE id = $1",
    [eventId],
  );
  return result[0];
}

async function readOutbox(
  eventId: string,
): Promise<EventOutboxRow | undefined> {
  const result = await rows<EventOutboxRow>(
    "SELECT event_id, dispatched_at FROM event_processing_outbox WHERE event_id = $1",
    [eventId],
  );
  return result[0];
}

async function readIssue(issueId: string): Promise<IssueSnapshot | undefined> {
  const result = await rows<IssueSnapshot>(
    `SELECT occurrence_count, affected_session_count, status, last_seen_at
     FROM issues WHERE id = $1`,
    [issueId],
  );
  return result[0];
}

async function readReproduction(
  reproductionId: string,
): Promise<ReproductionSnapshot | undefined> {
  const result = await rows<ReproductionSnapshot>(
    `SELECT id, event_id, status, code, generator_version
     FROM reproduction_tests WHERE id = $1`,
    [reproductionId],
  );
  return result[0];
}

async function countRows(
  table: string,
  where: string,
  values: unknown[],
): Promise<number> {
  const result = await rows<CountRow>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${where}`,
    values,
  );
  return Number(result[0]?.count ?? "0");
}

async function insertIssue(
  projectId: string,
  issueId = randomUUID(),
): Promise<string> {
  const now = new Date("2026-09-01T00:00:00.000Z");
  await client.pool.query(
    `INSERT INTO issues
       (id, project_id, fingerprint, fingerprint_signature, type, title,
        normalized_message, status, severity, first_seen_at, last_seen_at,
        occurrence_count, affected_session_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'exception', 'Retention test issue',
        'retention test message', 'open', 'error', $5, $5, 7, 3, $5, $5)`,
    [issueId, projectId, "a".repeat(64), "retention-test-signature", now],
  );
  return issueId;
}

async function insertInvitation(input: {
  workspaceId: string;
  userId: string;
  email: string;
  expiresAt: Date;
  acceptedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  const tokenHash = randomBytes(32).toString("hex");
  await client.pool.query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, email, role, token_hash, token_prefix,
        expires_at, accepted_at, revoked_at, created_by_user_id, created_at)
     VALUES ($1, $2, $3, 'member', $4, $5, $6, $7, NULL, $8, $9)`,
    [
      id,
      input.workspaceId,
      input.email,
      tokenHash,
      tokenHash.slice(0, 8),
      input.expiresAt,
      input.acceptedAt ?? null,
      input.userId,
      new Date(input.expiresAt.getTime() - 60 * 60 * 1000),
    ],
  );
  return id;
}

async function readInvitation(
  invitationId: string,
): Promise<{ revoked_at: Date | null; accepted_at: Date | null } | undefined> {
  const result = await rows<{
    revoked_at: Date | null;
    accepted_at: Date | null;
  }>(
    "SELECT revoked_at, accepted_at FROM workspace_invitations WHERE id = $1",
    [invitationId],
  );
  return result[0];
}

describe("retention cleanup with real PostgreSQL", () => {
  it("applies exact per-project cutoffs and bounded repeat-safe event batches", async () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const projectSeven = await seedProject(client);
    const projectThirty = await seedProject(client);
    await setRetentionDays(projectSeven.projectId, 7);
    await setRetentionDays(projectThirty.projectId, 30);

    const sevenBefore = await insertTestEvent(client, {
      projectId: projectSeven.projectId,
      eventType: "exception",
      payload: { marker: "processed-old" },
      occurredAt: new Date("2026-09-12T23:59:59.000Z"),
    });
    await markEventProcessed(sevenBefore.eventId, "processed");

    const sevenAtCutoff = await insertTestEvent(client, {
      projectId: projectSeven.projectId,
      eventType: "exception",
      payload: { marker: "exact-cutoff" },
      occurredAt: new Date("2026-09-13T00:00:00.000Z"),
    });
    await markEventProcessed(sevenAtCutoff.eventId, "processed");

    const thirtyBefore = await insertTestEvent(client, {
      projectId: projectThirty.projectId,
      eventType: "exception",
      payload: { marker: "rejected-old" },
      occurredAt: new Date("2026-08-20T23:59:59.000Z"),
    });
    await markEventProcessed(thirtyBefore.eventId, "rejected");

    const thirtyAtCutoff = await insertTestEvent(client, {
      projectId: projectThirty.projectId,
      eventType: "exception",
      payload: { marker: "thirty-day-cutoff" },
      occurredAt: new Date("2026-08-21T00:00:00.000Z"),
    });
    await markEventProcessed(thirtyAtCutoff.eventId, "processed");

    const pendingEvent = await insertTestEvent(client, {
      projectId: projectSeven.projectId,
      eventType: "exception",
      payload: { marker: "pending" },
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const processedPendingOutbox = await insertTestEvent(client, {
      projectId: projectSeven.projectId,
      eventType: "exception",
      payload: { marker: "pending-outbox" },
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await markEventProcessed(
      processedPendingOutbox.eventId,
      "processed",
      false,
    );

    const first = await runRetentionCleanupBatchForTest(projectSeven, {
      batchSize: 10,
      now,
    });
    expect(first.eventsDeleted).toBe(2);
    expect(await readEvent(sevenBefore.eventId)).toBeUndefined();
    expect(await readOutbox(sevenBefore.eventId)).toBeUndefined();
    expect(await readEvent(thirtyBefore.eventId)).toBeUndefined();
    expect(await readOutbox(thirtyBefore.eventId)).toBeUndefined();
    expect((await readEvent(sevenAtCutoff.eventId))?.id).toBe(
      sevenAtCutoff.eventId,
    );
    expect((await readEvent(thirtyAtCutoff.eventId))?.id).toBe(
      thirtyAtCutoff.eventId,
    );
    expect((await readEvent(pendingEvent.eventId))?.processing_state).toBe(
      "pending",
    );
    expect(
      (await readEvent(processedPendingOutbox.eventId))?.processing_state,
    ).toBe("processed");
    expect((await readOutbox(pendingEvent.eventId))?.dispatched_at).toBeNull();
    expect(
      (await readOutbox(processedPendingOutbox.eventId))?.dispatched_at,
    ).toBeNull();

    const repeated = await runRetentionCleanupBatchForTest(projectSeven, {
      batchSize: 10,
      now,
    });
    expect(repeated.eventsDeleted).toBe(0);

    const batchProject = await seedProject(client);
    await setRetentionDays(batchProject.projectId, 7);
    const batchEvents = await Promise.all(
      ["one", "two", "three"].map((marker, index) =>
        insertTestEvent(client, {
          projectId: batchProject.projectId,
          eventType: "exception",
          payload: { marker },
          occurredAt: new Date(
            `2026-09-${String(1 + index).padStart(2, "0")}T00:00:00.000Z`,
          ),
        }),
      ),
    );
    for (const event of batchEvents) {
      await markEventProcessed(event.eventId, "processed");
    }
    expect(
      (
        await runRetentionCleanupBatchForTest(batchProject, {
          batchSize: 1,
          now,
        })
      ).eventsDeleted,
    ).toBe(1);
    expect(
      (
        await runRetentionCleanupBatchForTest(batchProject, {
          batchSize: 1,
          now,
        })
      ).eventsDeleted,
    ).toBe(1);
    expect(
      (
        await runRetentionCleanupBatchForTest(batchProject, {
          batchSize: 10,
          now,
        })
      ).eventsDeleted,
    ).toBe(1);
    expect(
      (
        await runRetentionCleanupBatchForTest(batchProject, {
          batchSize: 10,
          now,
        })
      ).eventsDeleted,
    ).toBe(0);
  }, 90_000);

  it("partitions concurrent event batches with row locks", async () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const project = await seedProject(client);
    await setRetentionDays(project.projectId, 7);
    const events = await Promise.all(
      ["a", "b", "c", "d"].map((marker, index) =>
        insertTestEvent(client, {
          projectId: project.projectId,
          eventType: "exception",
          payload: { marker },
          occurredAt: new Date(
            `2026-09-${String(1 + index).padStart(2, "0")}T00:00:00.000Z`,
          ),
        }),
      ),
    );
    for (const event of events) {
      await markEventProcessed(event.eventId, "processed");
    }

    const passes = await Promise.all([
      runRetentionCleanupBatchForTest(project, { batchSize: 2, now }),
      runRetentionCleanupBatchForTest(project, { batchSize: 2, now }),
    ]);
    expect(
      passes.map((pass) => pass.eventsDeleted).reduce((a, b) => a + b, 0),
    ).toBe(4);
    for (const event of events) {
      expect(await readEvent(event.eventId)).toBeUndefined();
    }
  }, 90_000);

  it("protects pending reproductions and preserves completed history and issue state", async () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const project = await seedProject(client);
    await setRetentionDays(project.projectId, 7);
    const issueId = await insertIssue(project.projectId);
    const event = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: { marker: "reproduction-source" },
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await markEventProcessed(event.eventId, "processed", true, issueId);

    await client.pool.query(
      `INSERT INTO issue_activity
         (id, issue_id, actor_user_id, type, metadata_json, created_at)
       VALUES ($1, $2, NULL, 'created', $3::jsonb, $4)`,
      [randomUUID(), issueId, JSON.stringify({ marker: "keep" }), now],
    );
    await client.pool.query(
      `INSERT INTO issue_comments
         (id, issue_id, author_user_id, body_markdown, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $4)`,
      [randomUUID(), issueId, "Keep this comment", now],
    );

    const pendingReproductionId = randomUUID();
    const completedReproductionId = randomUUID();
    await client.pool.query(
      `INSERT INTO reproduction_tests
         (id, issue_id, event_id, generated_by_user_id, language, framework,
          code, has_redacted_steps, generator_version, status, completed_at, created_at)
       VALUES
         ($1, $3, $4, NULL, 'typescript', 'playwright', NULL, false, 'test-v1', 'pending', NULL, $5),
         ($2, $3, $4, NULL, 'typescript', 'playwright', $6, false, 'test-v1', 'ready', $5, $5)`,
      [
        pendingReproductionId,
        completedReproductionId,
        issueId,
        event.eventId,
        now,
        "generated source",
      ],
    );

    const protectedPass = await runRetentionCleanupBatchForTest(project, {
      batchSize: 10,
      now,
    });
    expect(protectedPass.eventsDeleted).toBe(0);
    expect((await readEvent(event.eventId))?.id).toBe(event.eventId);

    await client.pool.query(
      `UPDATE reproduction_tests
       SET status = 'ready', code = 'generated pending source', completed_at = $2
       WHERE id = $1`,
      [pendingReproductionId, now],
    );
    const deletedPass = await runRetentionCleanupBatchForTest(project, {
      batchSize: 10,
      now,
    });
    expect(deletedPass.eventsDeleted).toBe(1);
    expect(await readEvent(event.eventId)).toBeUndefined();

    const completed = await readReproduction(completedReproductionId);
    const formerlyPending = await readReproduction(pendingReproductionId);
    expect(completed).toMatchObject({
      id: completedReproductionId,
      event_id: null,
      status: "ready",
      code: "generated source",
      generator_version: "test-v1",
    });
    expect(formerlyPending).toMatchObject({
      id: pendingReproductionId,
      event_id: null,
      status: "ready",
      code: "generated pending source",
      generator_version: "test-v1",
    });
    expect(await readIssue(issueId)).toMatchObject({
      occurrence_count: 7,
      affected_session_count: 3,
      status: "open",
    });
    expect(await countRows("issue_activity", "issue_id = $1", [issueId])).toBe(
      1,
    );
    expect(await countRows("issue_comments", "issue_id = $1", [issueId])).toBe(
      1,
    );
    expect(
      (
        await rows<{ body_markdown: string }>(
          "SELECT body_markdown FROM issue_comments WHERE issue_id = $1",
          [issueId],
        )
      )[0]?.body_markdown,
    ).toBe("Keep this comment");
  }, 90_000);

  it("preserves affected-session lifetime identity and only removes childless old sessions", async () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const project = await seedProject(client);
    await setRetentionDays(project.projectId, 7);
    const issueId = await insertIssue(project.projectId);

    const affected = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: { marker: "affected-session" },
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await markEventProcessed(affected.eventId, "processed", true, issueId);
    await client.pool.query(
      `UPDATE telemetry_sessions
       SET started_at = $2, last_seen_at = $2
       WHERE id = $1`,
      [affected.sessionId, new Date("2026-09-01T00:00:00.000Z")],
    );
    await client.pool.query(
      `INSERT INTO issue_affected_sessions (issue_id, telemetry_session_id, first_seen_at)
       VALUES ($1, $2, $3)`,
      [issueId, affected.sessionId, new Date("2026-09-01T00:00:00.000Z")],
    );

    const retainedEvent = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: { marker: "retained-child" },
      occurredAt: new Date("2026-09-13T00:00:00.000Z"),
    });
    await markEventProcessed(retainedEvent.eventId, "processed");
    await client.pool.query(
      `UPDATE telemetry_sessions
       SET started_at = $2, last_seen_at = $2
       WHERE id = $1`,
      [retainedEvent.sessionId, new Date("2026-09-01T00:00:00.000Z")],
    );

    const emptySession = await upsertTelemetrySession(client.db, {
      projectId: project.projectId,
      sdkSessionId: `empty-${randomUUID()}`,
      anonymousUserHash: null,
      environment: "test",
      release: null,
      initialUrl: "http://localhost/empty",
      browserName: null,
      browserVersion: null,
      osName: null,
      osVersion: null,
      deviceType: null,
      viewportWidth: null,
      viewportHeight: null,
      sdkVersion: "test-sdk@0.0.0",
    });
    await client.pool.query(
      `UPDATE telemetry_sessions
       SET started_at = $2, last_seen_at = $2
       WHERE id = $1`,
      [emptySession.id, new Date("2026-09-01T00:00:00.000Z")],
    );

    const result = await runRetentionCleanupBatchForTest(project, {
      batchSize: 10,
      now,
    });
    expect(result.eventsDeleted).toBe(1);
    expect(result.sessionsDeleted).toBe(1);
    expect(
      await countRows("telemetry_sessions", "id = $1", [affected.sessionId]),
    ).toBe(1);
    expect(
      await countRows("telemetry_sessions", "id = $1", [
        retainedEvent.sessionId,
      ]),
    ).toBe(1);
    expect(
      await countRows("telemetry_sessions", "id = $1", [emptySession.id]),
    ).toBe(0);
    expect(
      await countRows(
        "issue_affected_sessions",
        "issue_id = $1 AND telemetry_session_id = $2",
        [issueId, affected.sessionId],
      ),
    ).toBe(1);
    expect(await readEvent(retainedEvent.eventId)).toMatchObject({
      id: retainedEvent.eventId,
    });
  }, 90_000);

  it("cleans rate limits in bounded concurrent batches with SKIP LOCKED", async () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const project = await seedProject(client);
    const old = new Date("2026-09-19T00:00:00.000Z");
    for (const [index, prefix] of ["first", "second", "third"].entries()) {
      await client.pool.query(
        `INSERT INTO rate_limit_buckets
           (project_id, key_prefix, bucket_start, request_count, event_count)
         VALUES ($1, $2, $3, 1, $4)`,
        [project.projectId, prefix, old, index],
      );
    }
    expect(await cleanupRateLimitBuckets(client.db, 60, 2, now)).toBe(2);
    expect(await cleanupRateLimitBuckets(client.db, 60, 2, now)).toBe(1);
    expect(await cleanupRateLimitBuckets(client.db, 60, 2, now)).toBe(0);

    for (const prefix of [
      "parallel-a",
      "parallel-b",
      "parallel-c",
      "parallel-d",
    ]) {
      await client.pool.query(
        `INSERT INTO rate_limit_buckets
           (project_id, key_prefix, bucket_start, request_count, event_count)
         VALUES ($1, $2, $3, 1, 1)`,
        [project.projectId, prefix, old],
      );
    }
    const concurrent = await Promise.all([
      cleanupRateLimitBuckets(client.db, 60, 2, now),
      cleanupRateLimitBuckets(client.db, 60, 2, now),
    ]);
    expect(concurrent.every((count: number) => count <= 2)).toBe(true);
    expect(
      concurrent.reduce((sum: number, count: number) => sum + count, 0),
    ).toBe(4);
    expect(
      await countRows("rate_limit_buckets", "project_id = $1", [
        project.projectId,
      ]),
    ).toBe(0);
  }, 90_000);

  it("retires invitations safely across concurrent bounded cleaners", async () => {
    const project = await seedProject(client);
    const now = new Date("2026-09-20T00:00:00.000Z");
    const reissueEmail = `expired-one-${randomUUID()}@example.com`;
    const expiredIds = await Promise.all(
      ["one", "two", "three", "four"].map((suffix) =>
        insertInvitation({
          workspaceId: project.workspaceId,
          userId: project.userId,
          email:
            suffix === "one"
              ? reissueEmail
              : `expired-${suffix}-${randomUUID()}@example.com`,
          expiresAt: new Date("2026-09-19T00:00:00.000Z"),
        }),
      ),
    );
    const futureId = await insertInvitation({
      workspaceId: project.workspaceId,
      userId: project.userId,
      email: `future-${randomUUID()}@example.com`,
      expiresAt: new Date("2026-09-21T00:00:00.000Z"),
    });
    const acceptedId = await insertInvitation({
      workspaceId: project.workspaceId,
      userId: project.userId,
      email: `accepted-${randomUUID()}@example.com`,
      expiresAt: new Date("2026-09-19T00:00:00.000Z"),
      acceptedAt: new Date("2026-09-18T00:00:00.000Z"),
    });

    const retired = await Promise.all([
      runExpiredInvitationCleanup({ db: client.db, batchSize: 2, now }),
      runExpiredInvitationCleanup({ db: client.db, batchSize: 2, now }),
    ]);
    expect(
      retired.map((pass) => pass.count).reduce((sum, count) => sum + count, 0),
    ).toBe(4);
    for (const id of expiredIds) {
      expect((await readInvitation(id))?.revoked_at).toEqual(now);
    }
    expect((await readInvitation(futureId))?.revoked_at).toBeNull();
    expect((await readInvitation(acceptedId))?.accepted_at).toEqual(
      new Date("2026-09-18T00:00:00.000Z"),
    );

    const reissueId = await insertInvitation({
      workspaceId: project.workspaceId,
      userId: project.userId,
      email: reissueEmail,
      expiresAt: new Date("2026-09-21T00:00:00.000Z"),
    });
    expect((await readInvitation(reissueId))?.revoked_at).toBeNull();
  }, 90_000);

  it("retries failed passes and drains a real runner without overlapping work", async () => {
    const project = await seedProject(client);
    await setRetentionDays(project.projectId, 7);
    const oldEvent = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: { marker: "runner" },
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await markEventProcessed(oldEvent.eventId, "processed");

    const runner = startRetentionCleanupRunner({
      db: client.db,
      batchSize: 1,
      intervalMs: 10,
      now: new Date("2026-09-20T00:00:00.000Z"),
      logger: createTestLogger(),
    });
    await waitFor(
      async () => {
        const event = await readEvent(oldEvent.eventId);
        return event === undefined ? true : null;
      },
      10_000,
      10,
    );
    await runner.stop();
    expect(await readEvent(oldEvent.eventId)).toBeUndefined();

    const failedRunner = startRetentionCleanupRunner({
      db: client.db,
      batchSize: 0,
      intervalMs: 10,
      logger: createTestLogger(),
    });
    await expect(failedRunner.runOnce()).rejects.toThrow(
      /Retention cleanup batch size/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await failedRunner.stop();
  }, 90_000);
});

async function runRetentionCleanupBatchForTest(
  _project: SeededProject,
  options: { batchSize: number; now: Date },
) {
  return runRetentionCleanup({
    db: client.db,
    batchSize: options.batchSize,
    now: options.now,
  });
}
