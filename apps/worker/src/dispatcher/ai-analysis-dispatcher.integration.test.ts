import { randomBytes, randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
import { AiAnalysisRepo } from "@replaybug/db";
import {
  GENERATE_AI_ANALYSIS_QUEUE,
  buildGenerateAiAnalysisJob,
  generateAiAnalysisQueueOptions,
  generateAiAnalysisSendOptions,
} from "../queues/ai-analysis.js";
import {
  createPgBossAiAnalysisPublisher,
  dispatchAiAnalysisOutboxBatch,
  reconcileAiAnalysisOutbox,
  sanitizeAiAnalysisOutboxError,
  startAiAnalysisDispatcher,
  type AiAnalysisPublisher,
} from "./ai-analysis-dispatcher.js";
import {
  createTestLogger,
  createTestWorkerConfig,
  createWorkerTestDatabase,
  seedProject,
  waitFor,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * AI analysis outbox dispatcher + reconciliation against real pg-boss and
 * real PostgreSQL (isolated temp database, no mocks of the queue).
 *
 * Covers: durable handoff before the worker processes, the publish crash
 * window (published job + undispatched row → dedup, exactly one job),
 * sanitized bounded failure handling, stale reconciliation, and clean stop.
 */

let testDb: WorkerTestDatabase;
let client: DbClient;
const logger = createTestLogger();
let boss: PgBoss;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  const config = createTestWorkerConfig({
    databaseUrl: testDb.databaseUrl,
    jobRetryLimit: 2,
  });
  boss = new PgBoss({
    connectionString: testDb.databaseUrl,
    schema: config.bossSchema,
    max: 4,
  });
  await boss.start();
  await boss.createQueue(
    GENERATE_AI_ANALYSIS_QUEUE,
    generateAiAnalysisQueueOptions(config),
  );
});

beforeEach(async () => {
  await boss.deleteAllJobs(GENERATE_AI_ANALYSIS_QUEUE);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await testDb.drop();
});

interface AiSeed {
  userId: string;
  projectId: string;
  issueId: string;
  eventId: string;
}

async function seedAiEvidence(db: DbClient): Promise<AiSeed> {
  const project = await seedProject(db);
  const issueId = randomUUID();
  const sessionId = randomUUID();
  const eventId = randomUUID();
  await db.pool.query(
    `INSERT INTO issues
       ("id", "project_id", "fingerprint", "fingerprint_signature",
        "type", "title", "normalized_message", "status", "severity",
        "first_seen_at", "last_seen_at", "occurrence_count", "affected_session_count")
     VALUES ($1, $2, $3, 'sig-ai', 'exception', 'TypeError: checkout',
             'TypeError: checkout', 'open', 'error',
             now() - interval '2 hours', now() - interval '1 hour', 1, 1)`,
    [issueId, project.projectId, randomBytes(32).toString("hex")],
  );
  await db.pool.query(
    `INSERT INTO telemetry_sessions
       ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
     VALUES ($1, $2, $3, 'production', 'https://demo.test/', 't@0')`,
    [sessionId, project.projectId, `sdk-${randomUUID()}`],
  );
  await db.pool.query(
    `INSERT INTO events
       ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at", "environment",
        "release", "page_url", "payload_json", "issue_id", "processing_state")
     VALUES ($1, $2, $3, $4, 1, 'exception', now(), 'production',
             'demo@1.0.0', 'https://demo.test/checkout', $5::jsonb, $6, 'processed')`,
    [
      eventId,
      project.projectId,
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
  return {
    userId: project.userId,
    projectId: project.projectId,
    issueId,
    eventId,
  };
}

async function insertPendingAnalysis(
  db: DbClient,
  seed: AiSeed,
): Promise<string> {
  const created = await AiAnalysisRepo.createAiAnalysisRequest(db.db, {
    issueId: seed.issueId,
    eventId: seed.eventId,
    requestedByUserId: seed.userId,
    model: "test-model",
    analysisVersion: "1.0.0",
    idempotencyKeyHash: randomBytes(32).toString("hex"),
  });
  return created.row.id;
}

interface AiOutboxShape {
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

async function readAiOutbox(
  db: DbClient,
  analysisId: string,
): Promise<AiOutboxShape | undefined> {
  const result = await db.pool.query(
    `SELECT dispatched_at, attempt_count, last_error, created_at
     FROM ai_analysis_outbox WHERE analysis_id = $1`,
    [analysisId],
  );
  return (result.rows as AiOutboxShape[])[0];
}

describe("AI analysis outbox dispatch (real pg-boss)", () => {
  it("hands a pending analysis to pg-boss with identifiers only before dispatch is marked", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await insertPendingAnalysis(client, seed);

    const summary = await dispatchAiAnalysisOutboxBatch(
      client.db,
      createPgBossAiAnalysisPublisher(boss),
      100,
      logger,
    );
    expect(summary).toEqual({
      claimed: 1,
      dispatched: 1,
      deduplicated: 0,
      failed: 0,
    });
    expect(
      (await readAiOutbox(client, analysisId))?.dispatched_at,
    ).not.toBeNull();

    const jobs = await boss.findJobs<{ version: number; analysisId: string }>(
      GENERATE_AI_ANALYSIS_QUEUE,
      { id: analysisId },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ version: 1, analysisId });
    // No telemetry evidence, prompt, or model output in the durable job.
    const serialized = JSON.stringify(jobs[0]?.data);
    expect(serialized).not.toContain("checkout");
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain("stacktrace");
  });

  it("reconciles a published-but-undispatched row via dedup without a duplicate job", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await insertPendingAnalysis(client, seed);
    const publisher = createPgBossAiAnalysisPublisher(boss);

    // Simulate the crash window: the job is durable in pg-boss but the
    // outbox row was never marked dispatched (stale, undispatched).
    const jobId = await boss.send(
      GENERATE_AI_ANALYSIS_QUEUE,
      buildGenerateAiAnalysisJob(analysisId),
      generateAiAnalysisSendOptions(analysisId),
    );
    expect(jobId).toBe(analysisId);
    expect((await readAiOutbox(client, analysisId))?.dispatched_at).toBeNull();
    await client.pool.query(
      `UPDATE ai_analysis_outbox
       SET created_at = now() - interval '1 hour' WHERE analysis_id = $1`,
      [analysisId],
    );

    const reconciled = await reconcileAiAnalysisOutbox(client.db, publisher, {
      batchSize: 100,
      staleAfterMs: 60_000,
      logger,
    });
    expect(reconciled.stalePending).toBe(1);
    expect(reconciled.dispatched).toBe(1);
    expect(reconciled.deduplicated).toBe(1);
    expect(reconciled.failed).toBe(0);
    expect(
      (await readAiOutbox(client, analysisId))?.dispatched_at,
    ).not.toBeNull();

    const jobs = await boss.findJobs(GENERATE_AI_ANALYSIS_QUEUE, {
      id: analysisId,
    });
    expect(jobs).toHaveLength(1);

    // Idle reconciliation finds nothing stale: no hot loop, no re-dispatch.
    const idle = await reconcileAiAnalysisOutbox(client.db, publisher, {
      batchSize: 100,
      staleAfterMs: 60_000,
      logger,
    });
    expect(idle.stalePending).toBe(0);
    expect(idle.claimed).toBe(0);
    expect(idle.dispatched).toBe(0);
  });

  it("records a sanitized bounded failure and keeps retrying after a publish error", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await insertPendingAnalysis(client, seed);

    const failingPublisher: AiAnalysisPublisher = {
      publishAiAnalysis(): Promise<string | null> {
        return Promise.reject(
          new Error("simulated pg-boss publish failure\nwith newline"),
        );
      },
    };

    const failedPass = await dispatchAiAnalysisOutboxBatch(
      client.db,
      failingPublisher,
      100,
      logger,
    );
    expect(failedPass.failed).toBe(1);
    expect(failedPass.dispatched).toBe(0);

    const afterFailure = await readAiOutbox(client, analysisId);
    expect(afterFailure?.dispatched_at).toBeNull();
    expect(afterFailure?.attempt_count).toBe(1);
    expect(afterFailure?.last_error).toBe(
      "simulated pg-boss publish failure with newline",
    );

    const recoveredPass = await dispatchAiAnalysisOutboxBatch(
      client.db,
      createPgBossAiAnalysisPublisher(boss),
      100,
      logger,
    );
    expect(recoveredPass.dispatched).toBe(1);
    const afterRecovery = await readAiOutbox(client, analysisId);
    expect(afterRecovery?.dispatched_at).not.toBeNull();
    expect(afterRecovery?.last_error).toBeNull();
  });

  it("stops the dispatcher loop cleanly", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await insertPendingAnalysis(client, seed);

    const handle = startAiAnalysisDispatcher({
      db: client.db,
      publisher: createPgBossAiAnalysisPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 50,
    });
    await waitFor(async () =>
      (await readAiOutbox(client, analysisId))?.dispatched_at ? true : null,
    );
    await handle.stop();
    expect(
      (await readAiOutbox(client, analysisId))?.dispatched_at,
    ).not.toBeNull();
  });
});

describe("sanitizeAiAnalysisOutboxError", () => {
  it("collapses whitespace and bounds the stored message", () => {
    const long = `failed\n\n${"x".repeat(900)}`;
    const sanitized = sanitizeAiAnalysisOutboxError(new Error(long));
    expect(sanitized).not.toContain("\n");
    expect(sanitized.length).toBe(500);
    expect(sanitizeAiAnalysisOutboxError("plain string")).toBe("plain string");
  });
});
