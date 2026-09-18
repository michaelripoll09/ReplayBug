import { describe, expect, it } from "vitest";
import { loadWorkerConfigFromEnv } from "./config.js";
import {
  PROCESS_EVENT_JOB_VERSION,
  PROCESS_EVENT_QUEUE,
  buildProcessEventJob,
  processEventJobSchema,
  processEventQueueOptions,
} from "./queues/process-event.js";
import { listRegisteredJobContracts } from "./queues/index.js";
import { sanitizeOutboxError } from "./dispatcher/publish-batch.js";

const BASE_ENV = {
  REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
};

describe("loadWorkerConfigFromEnv", () => {
  it("loads documented defaults with only the database URL set", () => {
    const config = loadWorkerConfigFromEnv({ ...BASE_ENV });
    expect(config.environment).toBe("development");
    expect(config.bossSchema).toBe("pgboss");
    expect(config.concurrency).toBe(2);
    expect(config.outboxBatchSize).toBe(100);
    expect(config.outboxPollMs).toBe(1000);
    expect(config.outboxReconcileMs).toBe(60_000);
    expect(config.jobRetryLimit).toBe(4);
    expect(config.jobPollMs).toBe(500);
  });

  it("fails fast with a readable message when the database URL is missing", () => {
    expect(() => loadWorkerConfigFromEnv({})).toThrow(
      /Invalid worker configuration/,
    );
  });

  it("parses explicit overrides", () => {
    const config = loadWorkerConfigFromEnv({
      ...BASE_ENV,
      REPLAYBUG_WORKER_CONCURRENCY: "5",
      REPLAYBUG_OUTBOX_BATCH_SIZE: "25",
      REPLAYBUG_OUTBOX_POLL_MS: "250",
      REPLAYBUG_OUTBOX_RECONCILE_MS: "5000",
      REPLAYBUG_JOB_RETRY_LIMIT: "2",
      REPLAYBUG_JOB_POLL_MS: "1000",
    });
    expect(config.concurrency).toBe(5);
    expect(config.outboxBatchSize).toBe(25);
    expect(config.outboxPollMs).toBe(250);
    expect(config.outboxReconcileMs).toBe(5000);
    expect(config.jobRetryLimit).toBe(2);
    expect(config.jobPollMs).toBe(1000);
  });

  it("rejects out-of-bounds values instead of clamping silently", () => {
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_WORKER_CONCURRENCY: "0",
      }),
    ).toThrow(/concurrency/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_OUTBOX_POLL_MS: "10",
      }),
    ).toThrow(/outboxPollMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_JOB_POLL_MS: "100",
      }),
    ).toThrow(/jobPollMs/);
  });

  it("rejects non-numeric values", () => {
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_WORKER_CONCURRENCY: "many",
      }),
    ).toThrow(/concurrency/);
  });
});

describe("process-event job contract", () => {
  it("registers exactly the process-event queue", () => {
    const contracts = listRegisteredJobContracts();
    expect(contracts).toEqual([
      { name: PROCESS_EVENT_QUEUE, version: PROCESS_EVENT_JOB_VERSION },
    ]);
  });

  it("builds a minimal versioned payload with only the event id", () => {
    const eventId = "550e8400-e29b-41d4-a716-446655440000";
    const job = buildProcessEventJob(eventId);
    expect(job).toEqual({ version: 1, eventId });
    expect(processEventJobSchema.safeParse(job).success).toBe(true);
  });

  it("rejects unknown versions and non-uuid event ids", () => {
    expect(
      processEventJobSchema.safeParse({ version: 2, eventId: "x" }).success,
    ).toBe(false);
    expect(
      processEventJobSchema.safeParse({
        version: 1,
        eventId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      processEventJobSchema.safeParse({
        version: 1,
        eventId: "550e8400-e29b-41d4-a716-446655440000",
        payloadJson: { secret: "must not be here" },
      }).success,
    ).toBe(true);
  });

  it("applies bounded retry options with exponential backoff", () => {
    const config = loadWorkerConfigFromEnv({ ...BASE_ENV });
    const options = processEventQueueOptions(config);
    expect(options.retryLimit).toBe(4);
    expect(options.retryBackoff).toBe(true);
    expect(options.retryDelay).toBe(1);
    expect(options.retryDelayMax).toBe(60);
    expect(options.expireInSeconds).toBe(60);
  });
});

describe("sanitizeOutboxError", () => {
  it("collapses whitespace and bounds the stored message", () => {
    const long = `failed\n\n${"x".repeat(900)}`;
    const sanitized = sanitizeOutboxError(new Error(long));
    expect(sanitized).not.toContain("\n");
    expect(sanitized.length).toBe(500);
  });

  it("handles non-Error throwables", () => {
    expect(sanitizeOutboxError("plain string")).toBe("plain string");
    expect(sanitizeOutboxError(undefined)).toBe("undefined");
  });
});
