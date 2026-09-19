import { randomBytes, randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentRepo,
  ReproductionRepo,
  type DbClient,
} from "@replaybug/db";
import { REPRODUCTION_GENERATOR_VERSION } from "@replaybug/reproducer";
import { processGenerateReproduction } from "./processors/generate-reproduction.js";
import {
  createPgBossReproductionPublisher,
  dispatchReproductionOutboxBatch,
  reconcileReproductionOutbox,
} from "./dispatcher/reproduction-dispatcher.js";
import {
  GENERATE_REPRODUCTION_JOB_VERSION,
  GENERATE_REPRODUCTION_QUEUE,
  generateReproductionQueueOptions,
} from "./queues/reproduction.js";
import {
  createTestLogger,
  createTestWorkerConfig,
  createWorkerTestDatabase,
  readActivityRows,
  readNotificationRows,
  seedProject,
  type WorkerTestDatabase,
} from "./test-helpers.js";

/**
 * Generate-reproduction integration against real PostgreSQL + real pg-boss
 * (isolated temp database, no mocks of the queue).
 *
 * Covers:
 * 1. Outbox crash window (publish → stale undispatched → reconcile dedupes,
 *    processor runs once, single activity).
 * 2. Deterministic failure semantics (unknown id no-op, terminal rows never
 *    resurrect, missing base URL fails once + notifies the requester).
 * 3. Exactly-once processor retry (double run keeps single activity,
 *    immutable code).
 */

let testDb: WorkerTestDatabase;
let client: DbClient;
const logger = createTestLogger();
let bossSchema: string;
let boss: PgBoss;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  const config = createTestWorkerConfig({
    databaseUrl: testDb.databaseUrl,
    jobRetryLimit: 2,
  });
  bossSchema = config.bossSchema;
  void bossSchema;
  boss = new PgBoss({
    connectionString: testDb.databaseUrl,
    schema: config.bossSchema,
    max: 4,
  });
  await boss.start();
  await boss.createQueue(
    GENERATE_REPRODUCTION_QUEUE,
    generateReproductionQueueOptions(config),
  );
});

beforeEach(async () => {
  await boss.deleteAllJobs(GENERATE_REPRODUCTION_QUEUE);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await testDb.drop();
});

interface ReproSeed {
  userId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  eventId: string;
  sessionId: string;
}

interface ReproOutboxShape {
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

const NAV_PAYLOAD: Record<string, unknown> = {
  from_url: "https://demo.test/",
  to_url: "https://demo.test/checkout",
};

const CLICK_PAYLOAD: Record<string, unknown> = {
  locator_candidates: [
    { type: "test_id", value: "checkout-button", confidence: 1.0 },
  ],
  element_tag: "button",
  element_role: "button",
  accessible_name: "Checkout",
  route: "/checkout",
};

const EXCEPTION_PAYLOAD: Record<string, unknown> = {
  values: [
    {
      type: "TypeError",
      value: "Cannot read properties of null (reading 'checkout')",
      stacktrace: { frames: [] },
    },
  ],
};

async function insertEventRow(
  db: DbClient,
  input: {
    id: string;
    projectId: string;
    sessionId: string;
    sequenceNumber: number;
    eventType: string;
    payload: Record<string, unknown>;
    issueId: string | null;
  },
): Promise<void> {
  await db.pool.query(
    `INSERT INTO events
       ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at",
        "environment", "release", "page_url", "payload_json",
        "issue_id", "processing_state")
     VALUES ($1, $2, $3, $4, $5, $6, now(),
             'production', 'demo@1.0.0', 'https://demo.test/checkout', $7::jsonb,
             $8, 'processed')`,
    [
      input.id,
      input.projectId,
      input.sessionId,
      randomUUID(),
      input.sequenceNumber,
      input.eventType,
      JSON.stringify(input.payload),
      input.issueId,
    ],
  );
}

async function seedReproEvidence(db: DbClient): Promise<ReproSeed> {
  const project = await seedProject(db);
  await EnvironmentRepo.insertEnvironment(db.db, {
    projectId: project.projectId,
    name: "production",
    baseUrl: "https://demo.test",
    isDefault: true,
  });

  const issueId = randomUUID();
  const sessionId = randomUUID();
  const eventId = randomUUID();
  const fingerprint = randomBytes(32).toString("hex");

  await db.pool.query(
    `INSERT INTO issues
       ("id", "project_id", "fingerprint", "fingerprint_signature",
        "type", "title", "normalized_message", "status", "severity",
        "first_seen_at", "last_seen_at", "occurrence_count", "affected_session_count")
     VALUES ($1, $2, $3, 'sig-repro', 'exception', 'TypeError: checkout',
             'TypeError: checkout', 'open', 'error',
             now() - interval '2 hours', now() - interval '1 hour', 1, 1)`,
    [issueId, project.projectId, fingerprint],
  );
  await db.pool.query(
    `INSERT INTO telemetry_sessions
       ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
     VALUES ($1, $2, $3, 'production', 'https://demo.test/', 't@0')`,
    [sessionId, project.projectId, `sdk-${randomUUID()}`],
  );
  await insertEventRow(db, {
    id: randomUUID(),
    projectId: project.projectId,
    sessionId,
    sequenceNumber: 1,
    eventType: "navigation",
    payload: NAV_PAYLOAD,
    issueId: null,
  });
  await insertEventRow(db, {
    id: randomUUID(),
    projectId: project.projectId,
    sessionId,
    sequenceNumber: 2,
    eventType: "click",
    payload: CLICK_PAYLOAD,
    issueId: null,
  });
  await insertEventRow(db, {
    id: eventId,
    projectId: project.projectId,
    sessionId,
    sequenceNumber: 3,
    eventType: "exception",
    payload: EXCEPTION_PAYLOAD,
    issueId,
  });

  return {
    userId: project.userId,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    issueId,
    eventId,
    sessionId,
  };
}

async function insertPendingWithOutbox(
  db: DbClient,
  input: { issueId: string; eventId: string; generatedByUserId: string },
): Promise<string> {
  return db.db.transaction(async (tx) => {
    const row = await ReproductionRepo.insertPendingReproduction(tx, {
      issueId: input.issueId,
      eventId: input.eventId,
      generatedByUserId: input.generatedByUserId,
      generatorVersion: REPRODUCTION_GENERATOR_VERSION,
    });
    await ReproductionRepo.insertReproductionOutbox(tx, row.id);
    return row.id;
  });
}

async function readReproOutbox(
  db: DbClient,
  reproductionId: string,
): Promise<ReproOutboxShape | undefined> {
  const result = await db.pool.query(
    `SELECT dispatched_at, attempt_count, last_error, created_at
     FROM reproduction_generation_outbox WHERE reproduction_id = $1`,
    [reproductionId],
  );
  const rows = result.rows as ReproOutboxShape[];
  return rows[0];
}

describe("reproduction outbox crash window (real pg-boss)", () => {
  it("publishes, reconciles a stale undispatched row via dedup, and generates exactly once", async () => {
    const seed = await seedReproEvidence(client);
    const reproductionId = await insertPendingWithOutbox(client, {
      issueId: seed.issueId,
      eventId: seed.eventId,
      generatedByUserId: seed.userId,
    });
    const publisher = createPgBossReproductionPublisher(boss);

    const dispatched = await dispatchReproductionOutboxBatch(
      client.db,
      publisher,
      100,
      logger,
    );
    expect(dispatched).toEqual({
      claimed: 1,
      dispatched: 1,
      deduplicated: 0,
      failed: 0,
    });
    expect(
      (await readReproOutbox(client, reproductionId))?.dispatched_at,
    ).not.toBeNull();

    const jobsAfterDispatch = await boss.findJobs(GENERATE_REPRODUCTION_QUEUE, {
      id: reproductionId,
    });
    expect(jobsAfterDispatch).toHaveLength(1);
    expect(jobsAfterDispatch[0]?.data).toEqual({
      version: GENERATE_REPRODUCTION_JOB_VERSION,
      reproductionId,
    });

    // Simulate the crash window: the job is durable in pg-boss but the
    // outbox row was never marked dispatched (stale, undispatched).
    await client.pool.query(
      `UPDATE reproduction_generation_outbox
       SET dispatched_at = NULL, created_at = now() - interval '1 hour'
       WHERE reproduction_id = $1`,
      [reproductionId],
    );
    expect(
      (await readReproOutbox(client, reproductionId))?.dispatched_at,
    ).toBeNull();

    const reconciled = await reconcileReproductionOutbox(client.db, publisher, {
      batchSize: 100,
      staleAfterMs: 60_000,
      logger,
    });
    expect(reconciled.stalePending).toBe(1);
    expect(reconciled.dispatched).toBe(1);
    expect(reconciled.deduplicated).toBe(1);
    expect(reconciled.failed).toBe(0);
    expect(
      (await readReproOutbox(client, reproductionId))?.dispatched_at,
    ).not.toBeNull();

    // Exactly one effective job despite two publish attempts (stable job id).
    const jobsAfterReconcile = await boss.findJobs(
      GENERATE_REPRODUCTION_QUEUE,
      {
        id: reproductionId,
      },
    );
    expect(jobsAfterReconcile).toHaveLength(1);

    // The processor runs once and records a single activity row.
    await processGenerateReproduction(
      { db: client.db, logger },
      { reproductionId },
    );
    const row = await ReproductionRepo.findReproductionById(
      client.db,
      reproductionId,
    );
    expect(row?.status).toBe("ready");
    expect(row?.code).toContain("@playwright/test");
    expect(row?.code).toContain("getByTestId('checkout-button')");

    const activity = await readActivityRows(client, seed.issueId);
    expect(
      activity.filter((entry) => entry.type === "reproduction_generated"),
    ).toHaveLength(1);

    // Second reconciliation finds nothing stale: no hot loop, no re-dispatch.
    const idle = await reconcileReproductionOutbox(client.db, publisher, {
      batchSize: 100,
      staleAfterMs: 60_000,
      logger,
    });
    expect(idle.stalePending).toBe(0);
    expect(idle.claimed).toBe(0);
    expect(idle.dispatched).toBe(0);
  });
});

describe("generate-reproduction deterministic failures", () => {
  it("is a no-op for unknown reproduction ids (never throws, never creates rows)", async () => {
    const missingId = randomUUID();
    await expect(
      processGenerateReproduction(
        { db: client.db, logger },
        { reproductionId: missingId },
      ),
    ).resolves.toBeUndefined();
    expect(
      await ReproductionRepo.findReproductionById(client.db, missingId),
    ).toBeUndefined();
  });

  it("fails once on missing base URL, notifies the requester, and never resurrects", async () => {
    const seed = await seedReproEvidence(client);
    await client.pool.query(
      `UPDATE project_environments SET base_url = NULL WHERE project_id = $1`,
      [seed.projectId],
    );

    // Inserted directly via the repo, bypassing API pre-validation.
    const reproductionId = await insertPendingWithOutbox(client, {
      issueId: seed.issueId,
      eventId: seed.eventId,
      generatedByUserId: seed.userId,
    });

    await processGenerateReproduction(
      { db: client.db, logger },
      { reproductionId },
    );

    const failed = await ReproductionRepo.findReproductionById(
      client.db,
      reproductionId,
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("REPRODUCTION_BASE_URL_REQUIRED");
    expect(failed?.completedAt).not.toBeNull();
    expect(failed?.code).toBeNull();

    const notifications = await readNotificationRows(client, seed.issueId);
    const failureNotes = notifications.filter(
      (entry) => entry.type === "reproduction_failed",
    );
    expect(failureNotes).toHaveLength(1);
    expect(failureNotes[0]?.user_id).toBe(seed.userId);
    expect(failureNotes[0]?.workspace_id).toBe(seed.workspaceId);
    expect(failureNotes[0]?.project_id).toBe(seed.projectId);

    const activityBefore = await readActivityRows(client, seed.issueId);
    expect(
      activityBefore.filter((entry) => entry.type === "reproduction_generated"),
    ).toHaveLength(1);

    // A failed row stays failed: retrying never resurrects it and never
    // duplicates activity or notifications.
    await processGenerateReproduction(
      { db: client.db, logger },
      { reproductionId },
    );
    const stillFailed = await ReproductionRepo.findReproductionById(
      client.db,
      reproductionId,
    );
    expect(stillFailed?.status).toBe("failed");
    expect(stillFailed?.errorCode).toBe("REPRODUCTION_BASE_URL_REQUIRED");

    const activityAfter = await readActivityRows(client, seed.issueId);
    expect(
      activityAfter.filter((entry) => entry.type === "reproduction_generated"),
    ).toHaveLength(1);
    const notificationsAfter = await readNotificationRows(client, seed.issueId);
    expect(
      notificationsAfter.filter(
        (entry) => entry.type === "reproduction_failed",
      ),
    ).toHaveLength(1);
  });
});

describe("generate-reproduction exactly-once", () => {
  it("processes the same ready reproduction twice with a single activity row and immutable code", async () => {
    const seed = await seedReproEvidence(client);
    const reproductionId = await insertPendingWithOutbox(client, {
      issueId: seed.issueId,
      eventId: seed.eventId,
      generatedByUserId: seed.userId,
    });

    await processGenerateReproduction(
      { db: client.db, logger },
      { reproductionId },
    );
    const first = await ReproductionRepo.findReproductionById(
      client.db,
      reproductionId,
    );
    expect(first?.status).toBe("ready");
    const firstCode = first?.code;
    expect(typeof firstCode).toBe("string");
    const firstCompletedAt =
      first?.completedAt instanceof Date
        ? first.completedAt.getTime()
        : new Date(first?.completedAt ?? 0).getTime();

    await processGenerateReproduction(
      { db: client.db, logger },
      { reproductionId },
    );
    const second = await ReproductionRepo.findReproductionById(
      client.db,
      reproductionId,
    );
    expect(second?.status).toBe("ready");
    expect(second?.code).toBe(firstCode);
    const secondCompletedAt =
      second?.completedAt instanceof Date
        ? second.completedAt.getTime()
        : new Date(second?.completedAt ?? 0).getTime();
    expect(secondCompletedAt).toBe(firstCompletedAt);

    const activity = await readActivityRows(client, seed.issueId);
    expect(
      activity.filter((entry) => entry.type === "reproduction_generated"),
    ).toHaveLength(1);

    // Ready rows never produce failure notifications.
    const notifications = await readNotificationRows(client, seed.issueId);
    expect(
      notifications.filter((entry) => entry.type === "reproduction_failed"),
    ).toHaveLength(0);
  });
});
