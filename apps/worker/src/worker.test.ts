import { describe, expect, it } from "vitest";
import { loadWorkerConfigFromEnv } from "./config.js";
import {
  PROCESS_EVENT_JOB_VERSION,
  PROCESS_EVENT_QUEUE,
  buildProcessEventJob,
  processEventJobSchema,
  processEventQueueOptions,
} from "./queues/process-event.js";
import {
  GENERATE_REPRODUCTION_JOB_VERSION,
  GENERATE_REPRODUCTION_QUEUE,
} from "./queues/reproduction.js";
import {
  GENERATE_AI_ANALYSIS_JOB_VERSION,
  GENERATE_AI_ANALYSIS_QUEUE,
} from "./queues/ai-analysis.js";
import { listRegisteredJobContracts } from "./queues/index.js";
import { sanitizeOutboxError } from "./dispatcher/publish-batch.js";
import { startExpiredInvitationCleanupRunner } from "./cleanup/invitations.js";
import { startRetentionCleanupRunner } from "./cleanup/retention.js";
import { createTestDbClient, createTestLogger } from "./test-helpers.js";

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
    expect(config.artifactDeletionBatchSize).toBe(100);
    expect(config.artifactDeletionPollMs).toBe(1000);
    expect(config.reproductionOutboxBatchSize).toBe(100);
    expect(config.reproductionOutboxPollMs).toBe(1000);
    expect(config.reproductionOutboxReconcileMs).toBe(60_000);
    expect(config.jobRetryLimit).toBe(4);
    expect(config.jobPollMs).toBe(500);
    expect(config.invitationCleanupBatchSize).toBe(100);
    expect(config.invitationCleanupIntervalMs).toBe(60_000);
    expect(config.retentionCleanupBatchSize).toBe(100);
    expect(config.retentionCleanupIntervalMs).toBe(60_000);
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
      REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE: "25",
      REPLAYBUG_ARTIFACT_DELETION_POLL_MS: "250",
      REPLAYBUG_JOB_RETRY_LIMIT: "2",
      REPLAYBUG_JOB_POLL_MS: "1000",
      REPLAYBUG_INVITATION_CLEANUP_BATCH_SIZE: "25",
      REPLAYBUG_INVITATION_CLEANUP_INTERVAL_MS: "5000",
      REPLAYBUG_RETENTION_CLEANUP_BATCH_SIZE: "25",
      REPLAYBUG_RETENTION_CLEANUP_INTERVAL_MS: "5000",
    });
    expect(config.concurrency).toBe(5);
    expect(config.outboxBatchSize).toBe(25);
    expect(config.outboxPollMs).toBe(250);
    expect(config.outboxReconcileMs).toBe(5000);
    expect(config.artifactDeletionBatchSize).toBe(25);
    expect(config.artifactDeletionPollMs).toBe(250);
    expect(config.jobRetryLimit).toBe(2);
    expect(config.jobPollMs).toBe(1000);
    expect(config.invitationCleanupBatchSize).toBe(25);
    expect(config.invitationCleanupIntervalMs).toBe(5000);
    expect(config.retentionCleanupBatchSize).toBe(25);
    expect(config.retentionCleanupIntervalMs).toBe(5000);
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
        REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE: "0",
      }),
    ).toThrow(/artifactDeletionBatchSize/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_ARTIFACT_DELETION_POLL_MS: "99",
      }),
    ).toThrow(/artifactDeletionPollMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_JOB_POLL_MS: "100",
      }),
    ).toThrow(/jobPollMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_INVITATION_CLEANUP_BATCH_SIZE: "0",
      }),
    ).toThrow(/invitationCleanupBatchSize/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_INVITATION_CLEANUP_BATCH_SIZE: "101",
      }),
    ).toThrow(/invitationCleanupBatchSize/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_INVITATION_CLEANUP_INTERVAL_MS: "999",
      }),
    ).toThrow(/invitationCleanupIntervalMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_INVITATION_CLEANUP_INTERVAL_MS: "3600001",
      }),
    ).toThrow(/invitationCleanupIntervalMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_RETENTION_CLEANUP_BATCH_SIZE: "0",
      }),
    ).toThrow(/retentionCleanupBatchSize/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_RETENTION_CLEANUP_BATCH_SIZE: "1001",
      }),
    ).toThrow(/retentionCleanupBatchSize/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_RETENTION_CLEANUP_INTERVAL_MS: "999",
      }),
    ).toThrow(/retentionCleanupIntervalMs/);
    expect(() =>
      loadWorkerConfigFromEnv({
        ...BASE_ENV,
        REPLAYBUG_RETENTION_CLEANUP_INTERVAL_MS: "3600001",
      }),
    ).toThrow(/retentionCleanupIntervalMs/);
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

describe("cleanup runner shutdown", () => {
  it("drains rejected in-flight passes without rejecting stop", async () => {
    const client = createTestDbClient();
    try {
      const retentionRunner = startRetentionCleanupRunner({
        db: client.db,
        batchSize: 0,
        intervalMs: 60_000,
        logger: createTestLogger(),
      });
      const retentionPass = retentionRunner.runOnce();
      await expect(retentionRunner.stop()).resolves.toBeUndefined();
      await expect(retentionPass).rejects.toThrow(
        /Retention cleanup batch size/,
      );

      const invitationRunner = startExpiredInvitationCleanupRunner({
        db: client.db,
        batchSize: 0,
        intervalMs: 60_000,
        logger: createTestLogger(),
      });
      const invitationPass = invitationRunner.runOnce();
      await expect(invitationRunner.stop()).resolves.toBeUndefined();
      await expect(invitationPass).rejects.toThrow(/Query limit/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("process-event job contract", () => {
  it("registers the process-event, generate-reproduction, and generate-ai-analysis queues", () => {
    const contracts = listRegisteredJobContracts();
    expect(contracts).toEqual([
      { name: PROCESS_EVENT_QUEUE, version: PROCESS_EVENT_JOB_VERSION },
      {
        name: GENERATE_REPRODUCTION_QUEUE,
        version: GENERATE_REPRODUCTION_JOB_VERSION,
      },
      {
        name: GENERATE_AI_ANALYSIS_QUEUE,
        version: GENERATE_AI_ANALYSIS_JOB_VERSION,
      },
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
