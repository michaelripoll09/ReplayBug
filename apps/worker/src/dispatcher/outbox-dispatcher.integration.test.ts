import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
import {
  PROCESS_EVENT_QUEUE,
  buildProcessEventJob,
  processEventQueueOptions,
  processEventSendOptions,
} from "../queues/process-event.js";
import { createPgBossPublisher, startWorkerRuntime } from "../worker.js";
import { processEvent } from "../processors/process-event.js";
import { createProcessEventJobHandler } from "../processors/process-event-handler.js";
import {
  dispatchOutboxBatch,
  startOutboxDispatcher,
} from "./outbox-dispatcher.js";
import { reconcileOutbox } from "../reconciliation/outbox-reconciliation.js";
import type { ProcessEventPublisher } from "./publish-batch.js";
import {
  createTestLogger,
  createTestWorkerConfig,
  createWorkerTestDatabase,
  exceptionPayload,
  insertTestEvent,
  readEventRow,
  readIssuesByProject,
  readOutboxRow,
  seedProject,
  waitFor,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * Outbox dispatcher, reconciliation and pg-boss integration against real
 * PostgreSQL (isolated temp database). Uses the real pg-boss package — no
 * mocks of the queue.
 */

let testDb: WorkerTestDatabase;
let client: DbClient;
const logger = createTestLogger();
let config: ReturnType<typeof createTestWorkerConfig>;
let boss: PgBoss;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  config = createTestWorkerConfig({
    databaseUrl: testDb.databaseUrl,
    jobRetryLimit: 2,
  });
  boss = new PgBoss({
    connectionString: testDb.databaseUrl,
    schema: config.bossSchema,
    max: 4,
  });
  await boss.start();
  await boss.createQueue(PROCESS_EVENT_QUEUE, processEventQueueOptions(config));
});

beforeEach(async () => {
  await boss.deleteAllJobs(PROCESS_EVENT_QUEUE);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await testDb.drop();
});

async function jobRow(eventId: string): Promise<
  | {
      state: string;
      retry_count: number;
      retry_limit: number;
      output: unknown;
    }
  | undefined
> {
  const result = await client.pool.query(
    `SELECT state, retry_count, retry_limit, output
     FROM ${config.bossSchema}.job WHERE name = $1 AND id = $2`,
    [PROCESS_EVENT_QUEUE, eventId],
  );
  return result.rows[0] as
    | {
        state: string;
        retry_count: number;
        retry_limit: number;
        output: unknown;
      }
    | undefined;
}

describe("outbox dispatch with real pg-boss", () => {
  it("hands a pending row to pg-boss durably before the worker processes it", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("dispatch test"),
    });

    const summary = await dispatchOutboxBatch({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 500,
    });
    expect(summary).toEqual({
      claimed: 1,
      dispatched: 1,
      deduplicated: 0,
      failed: 0,
    });

    const outbox = await readOutboxRow(client, eventId);
    expect(outbox?.dispatched_at).not.toBeNull();
    expect(outbox?.attempt_count).toBe(0);

    // Dispatched means "handed to pg-boss": the event is still pending.
    const beforeProcessing = await readEventRow(client, eventId);
    expect(beforeProcessing?.processing_state).toBe("pending");

    const jobs = await boss.findJobs<{ version: number; eventId: string }>(
      PROCESS_EVENT_QUEUE,
      { id: eventId },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ version: 1, eventId });

    // Then the worker consumes it.
    const outcome = await processEvent({ db: client.db }, eventId);
    expect(outcome.status).toBe("processed");
    const afterProcessing = await readEventRow(client, eventId);
    expect(afterProcessing?.processing_state).toBe("processed");
  });

  it("survives the crash window: job published, outbox row still undispatched", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("crash window"),
    });

    // Simulate the dispatcher crashing after a successful publish and before
    // marking the row: the durable job exists, dispatched_at is still null.
    const jobId = await boss.send(
      PROCESS_EVENT_QUEUE,
      buildProcessEventJob(eventId),
      processEventSendOptions(eventId),
    );
    expect(jobId).toBe(eventId);
    expect((await readOutboxRow(client, eventId))?.dispatched_at).toBeNull();

    // Restart: the dispatcher re-publishes; pg-boss deduplicates by job id.
    const summary = await dispatchOutboxBatch({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 500,
    });
    expect(summary.deduplicated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(
      (await readOutboxRow(client, eventId))?.dispatched_at,
    ).not.toBeNull();

    // Exactly one effective job, and executing it twice stays idempotent.
    const jobs = await boss.findJobs(PROCESS_EVENT_QUEUE, { id: eventId });
    expect(jobs).toHaveLength(1);
    await processEvent({ db: client.db }, eventId);
    await processEvent({ db: client.db }, eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
  });

  it("records a sanitized failure and keeps retrying after a publish error", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("publish failure"),
    });

    const failingPublisher: ProcessEventPublisher = {
      publishProcessEvent(): Promise<string | null> {
        return Promise.reject(
          new Error("simulated pg-boss publish failure\nwith newline"),
        );
      },
    };

    const failedPass = await dispatchOutboxBatch({
      db: client.db,
      publisher: failingPublisher,
      logger,
      batchSize: 100,
      pollMs: 500,
    });
    expect(failedPass.failed).toBe(1);
    expect(failedPass.dispatched).toBe(0);

    const afterFailure = await readOutboxRow(client, eventId);
    expect(afterFailure?.dispatched_at).toBeNull();
    expect(afterFailure?.attempt_count).toBe(1);
    expect(afterFailure?.last_error).toBe(
      "simulated pg-boss publish failure with newline",
    );

    // The dispatcher remains operational: the next pass completes the row.
    const recoveredPass = await dispatchOutboxBatch({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 500,
    });
    expect(recoveredPass.dispatched).toBe(1);
    const afterRecovery = await readOutboxRow(client, eventId);
    expect(afterRecovery?.dispatched_at).not.toBeNull();
    expect(afterRecovery?.attempt_count).toBe(1);
    expect(afterRecovery?.last_error).toBeNull();
  });

  it("reconciliation retries stale pending rows once, without a hot loop", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("stale row"),
    });
    await client.pool.query(
      `UPDATE event_processing_outbox
       SET created_at = now() - interval '1 hour' WHERE event_id = $1`,
      [eventId],
    );

    const deps = {
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      intervalMs: 60_000,
      staleAfterMs: 60_000,
    };
    const first = await reconcileOutbox(deps);
    expect(first.stalePending).toBe(1);
    expect(first.dispatched).toBe(1);
    expect(
      (await readOutboxRow(client, eventId))?.dispatched_at,
    ).not.toBeNull();

    // Second pass finds nothing stale: no repeated work, no hot loop.
    const second = await reconcileOutbox(deps);
    expect(second.stalePending).toBe(0);
    expect(second.claimed).toBe(0);
  });

  it("stops the dispatcher loop cleanly", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("loop stop"),
    });

    const handle = startOutboxDispatcher({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 50,
    });
    await waitFor(async () =>
      (await readOutboxRow(client, eventId))?.dispatched_at ? true : null,
    );
    await handle.stop();
    const afterStop = await readOutboxRow(client, eventId);
    expect(afterStop?.dispatched_at).not.toBeNull();
  });
});

describe("pg-boss worker behavior", () => {
  it("retries a transient processor failure and processes the event exactly once", async () => {
    const project = await seedProject(client);
    const events = [];
    for (let index = 0; index < 1; index++) {
      events.push(
        await insertTestEvent(client, {
          projectId: project.projectId,
          eventType: "exception",
          payload: exceptionPayload("transient retry"),
        }),
      );
    }
    const eventId = events[0]?.eventId ?? "";

    await dispatchOutboxBatch({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 500,
    });

    const realHandler = createProcessEventJobHandler({
      db: client.db,
      logger,
    });
    let attempts = 0;
    await boss.work(
      PROCESS_EVENT_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5, localConcurrency: 1 },
      async (jobs) => {
        attempts++;
        if (attempts === 1) {
          throw new Error("transient failure injected by test");
        }
        await realHandler(jobs);
      },
    );

    try {
      await waitFor(async () => {
        const row = await readEventRow(client, eventId);
        return row?.processing_state === "processed" ? row : null;
      }, 40_000);
    } finally {
      await boss.offWork(PROCESS_EVENT_QUEUE, { wait: true });
    }

    expect(attempts).toBeGreaterThanOrEqual(2);
    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
    expect(issues[0]?.affected_session_count).toBe(1);
  }, 60_000);

  it("fails poison jobs after bounded retries and keeps the worker alive", async () => {
    const project = await seedProject(client);
    const poison = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("poison job"),
    });
    const healthy = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("healthy job"),
    });

    await dispatchOutboxBatch({
      db: client.db,
      publisher: createPgBossPublisher(boss),
      logger,
      batchSize: 100,
      pollMs: 500,
    });

    const realHandler = createProcessEventJobHandler({
      db: client.db,
      logger,
    });
    await boss.work(
      PROCESS_EVENT_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5, localConcurrency: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const data = job.data as { eventId?: string };
          if (data.eventId === poison.eventId) {
            throw new Error("persistent poison failure injected by test");
          }
        }
        await realHandler(jobs);
      },
    );

    try {
      const failedJob = await waitFor(async () => {
        const row = await jobRow(poison.eventId);
        return row?.state === "failed" ? row : null;
      }, 40_000);
      expect(failedJob.retry_count).toBe(config.jobRetryLimit);
      expect(failedJob.retry_limit).toBe(config.jobRetryLimit);

      // The worker kept working: the healthy job is processed.
      await waitFor(async () => {
        const row = await readEventRow(client, healthy.eventId);
        return row?.processing_state === "processed" ? row : null;
      }, 20_000);
    } finally {
      await boss.offWork(PROCESS_EVENT_QUEUE, { wait: true });
    }

    // Poison event stays pending with a failed, inspectable job: operators
    // can inspect state/retry_count and retry it explicitly.
    const poisonRow = await readEventRow(client, poison.eventId);
    expect(poisonRow?.processing_state).toBe("pending");
    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fingerprint_signature).toContain("healthy job");
  }, 90_000);
});

describe("worker downtime and restart", () => {
  it("drains events accepted while no worker was running", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("accepted during downtime"),
    });

    // No dispatcher and no worker have run: the accepted event is durable.
    const before = await readEventRow(client, eventId);
    expect(before?.processing_state).toBe("pending");
    expect((await readOutboxRow(client, eventId))?.dispatched_at).toBeNull();

    const runtimeConfig = createTestWorkerConfig({
      databaseUrl: testDb.databaseUrl,
      outboxPollMs: 100,
    });
    const runtime = await startWorkerRuntime({
      config: runtimeConfig,
      logger,
      client,
    });
    try {
      await waitFor(async () => {
        const row = await readEventRow(client, eventId);
        return row?.processing_state === "processed" ? row : null;
      }, 60_000);
    } finally {
      await runtime.stop();
    }

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
    expect(
      (await readOutboxRow(client, eventId))?.dispatched_at,
    ).not.toBeNull();
  }, 90_000);
});
