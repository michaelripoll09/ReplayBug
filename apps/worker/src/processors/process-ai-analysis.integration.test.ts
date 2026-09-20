import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AiAnalysisRepo, type DbClient } from "@replaybug/db";
import type { Logger } from "@replaybug/observability";
import type { OllamaCapability } from "../config.js";
import {
  GENERATE_AI_ANALYSIS_QUEUE,
  buildGenerateAiAnalysisJob,
  generateAiAnalysisQueueOptions,
  generateAiAnalysisSendOptions,
} from "../queues/ai-analysis.js";
import {
  createGenerateAiAnalysisJobHandler,
  processAiAnalysis,
} from "./process-ai-analysis.js";
import {
  createTestLogger,
  createTestWorkerConfig,
  createWorkerTestDatabase,
  readActivityRows,
  readNotificationRows,
  seedProject,
  waitFor,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * AI analysis lifecycle processor against real PostgreSQL + an ephemeral
 * mock Ollama HTTP server (random port per test, no fixed shared ports).
 *
 * Covers: success (pending→ready, one model call, activity, requester-only
 * notification, identifier-only pg_notify), timeout/500/429/connection
 * refusal retry taxonomy, invalid JSON/schema/refs, retry exhaustion, outbox
 * crash window, concurrent duplicate jobs, terminal retries, and log/privacy
 * boundaries.
 */

const SUMMARY_MARKER = "UNIQUE_SUMMARY_MARKER_12345";
const ISSUE_MESSAGE_MARKER = "MARKER_ISSUE_MESSAGE_checkout";
const LATER_EVENT_MARKER = "LATER_EVENT_MARKER_after_occurrence";

const validOutput = {
  summary: SUMMARY_MARKER,
  suspectedCause: "The server returned an error before the order was saved.",
  evidence: [
    { ref: "issue:message", reason: "The issue message reports the failure." },
  ],
  reproductionSteps: ["Open checkout and submit the form."],
  limitations: ["Only the supplied bounded evidence was analyzed."],
};

function validBody(): string {
  return JSON.stringify({
    message: { role: "assistant", content: JSON.stringify(validOutput) },
  });
}

interface MockServer {
  url: string;
  requests: Array<{ body: unknown }>;
  close(): Promise<void>;
}

async function startMock(
  responses: Array<{
    status?: number;
    body?: string;
    delayMs?: number;
    close?: boolean;
  }>,
): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    const next = responses.shift() ?? {};
    if (next.close) {
      request.socket.destroy();
      return;
    }
    if (next.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }
    response.writeHead(next.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(next.body ?? validBody());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function configuredCapability(
  mock: MockServer,
  timeoutMs = 1_000,
): OllamaCapability {
  return {
    state: "configured",
    baseUrl: mock.url,
    model: "test-model",
    timeoutMs,
  };
}

interface CapturingLogger {
  entries: unknown[][];
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

function createCapturingLogger(): CapturingLogger {
  const entries: unknown[][] = [];
  const capture = (...args: unknown[]): void => {
    entries.push(args);
  };
  return {
    entries,
    logger: {
      info: capture,
      warn: capture,
      error: capture,
      debug: capture,
    } as unknown as Pick<Logger, "info" | "warn" | "error" | "debug">,
  };
}

interface UpdateListener {
  payloads: Record<string, unknown>[];
  close(): Promise<void>;
}

async function listenForUpdates(databaseUrl: string): Promise<UpdateListener> {
  const listener = new Client({ connectionString: databaseUrl });
  const payloads: Record<string, unknown>[] = [];
  listener.on("notification", (message) => {
    if (message.channel !== "replaybug_project_updates") return;
    try {
      payloads.push(
        JSON.parse(message.payload ?? "null") as Record<string, unknown>,
      );
    } catch {
      payloads.push({ invalid: message.payload });
    }
  });
  await listener.connect();
  await listener.query(`LISTEN "replaybug_project_updates"`);
  return { payloads, close: () => listener.end() };
}

let testDb: WorkerTestDatabase;
let client: DbClient;
let boss: PgBoss;
const mocks: MockServer[] = [];
const listeners: UpdateListener[] = [];

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  const config = createTestWorkerConfig({ databaseUrl: testDb.databaseUrl });
  boss = new PgBoss({
    connectionString: testDb.databaseUrl,
    schema: config.bossSchema,
    max: 4,
  });
  await boss.start();
  await boss.createQueue(
    GENERATE_AI_ANALYSIS_QUEUE,
    generateAiAnalysisQueueOptions(
      createTestWorkerConfig({
        databaseUrl: testDb.databaseUrl,
        jobRetryLimit: 1,
      }),
    ),
  );
});

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.close()));
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await boss.deleteAllJobs(GENERATE_AI_ANALYSIS_QUEUE);
});

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await testDb.drop();
});

interface AiSeed {
  userId: string;
  otherUserId: string;
  workspaceId: string;
  projectId: string;
  issueId: string;
  eventId: string;
  sessionId: string;
}

async function seedAiEvidence(db: DbClient): Promise<AiSeed> {
  const project = await seedProject(db);
  const otherUserId = `other-user-${randomUUID().slice(0, 8)}`;
  await db.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Other Member', $2, false, now(), now())`,
    [otherUserId, `${otherUserId}@example.com`],
  );
  await db.pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [project.workspaceId, otherUserId],
  );

  const issueId = randomUUID();
  const sessionId = randomUUID();
  const eventId = randomUUID();
  await db.pool.query(
    `INSERT INTO issues
       ("id", "project_id", "fingerprint", "fingerprint_signature",
        "type", "title", "normalized_message", "status", "severity",
        "first_seen_at", "last_seen_at", "occurrence_count", "affected_session_count")
     VALUES ($1, $2, $3, 'sig-ai', 'exception', 'TypeError: checkout',
             $4, 'open', 'error',
             now() - interval '2 hours', now() - interval '1 hour', 1, 1)`,
    [
      issueId,
      project.projectId,
      randomBytes(32).toString("hex"),
      ISSUE_MESSAGE_MARKER,
    ],
  );
  await db.pool.query(
    `INSERT INTO telemetry_sessions
       ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
     VALUES ($1, $2, $3, 'production', 'https://demo.test/', 't@0')`,
    [sessionId, project.projectId, `sdk-${randomUUID()}`],
  );
  const insertEvent = async (
    id: string,
    sequenceNumber: number,
    eventType: string,
    payload: Record<string, unknown>,
    issue: string | null,
  ): Promise<void> => {
    await db.pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at", "environment",
          "release", "page_url", "payload_json", "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, $5, $6, now(), 'production',
               'demo@1.0.0', 'https://demo.test/checkout', $7::jsonb, $8, 'processed')`,
      [
        id,
        project.projectId,
        sessionId,
        randomUUID(),
        sequenceNumber,
        eventType,
        JSON.stringify(payload),
        issue,
      ],
    );
  };
  await insertEvent(
    randomUUID(),
    1,
    "navigation",
    { to_url: "/checkout" },
    null,
  );
  await insertEvent(
    randomUUID(),
    2,
    "network",
    {
      method: "GET",
      url: "https://api.test/orders?token=secret",
      status_code: 500,
    },
    null,
  );
  await insertEvent(
    eventId,
    3,
    "exception",
    {
      values: [
        {
          type: "TypeError",
          value: ISSUE_MESSAGE_MARKER,
          stacktrace: {
            frames: [
              {
                filename: "app.js",
                function: "submit",
                lineno: 10,
                colno: 5,
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    issueId,
  );
  // Same session, after the selected occurrence: must never enter the bundle.
  await insertEvent(
    randomUUID(),
    4,
    "console_error",
    { args: [LATER_EVENT_MARKER] },
    null,
  );

  return {
    userId: project.userId,
    otherUserId,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    issueId,
    eventId,
    sessionId,
  };
}

async function createAnalysis(
  db: DbClient,
  seed: AiSeed,
  overrides: { eventId?: string | null } = {},
): Promise<string> {
  const created = await AiAnalysisRepo.createAiAnalysisRequest(db.db, {
    issueId: seed.issueId,
    eventId: overrides.eventId === undefined ? seed.eventId : overrides.eventId,
    requestedByUserId: seed.userId,
    model: "test-model",
    analysisVersion: "1.0.0",
    idempotencyKeyHash: randomBytes(32).toString("hex"),
  });
  return created.row.id;
}

async function readAnalysis(
  db: DbClient,
  analysisId: string,
): Promise<AiAnalysisRepo.AiAnalysisRow | undefined> {
  return AiAnalysisRepo.findAiAnalysisById(db.db, analysisId);
}

function countActivity(
  rows: Awaited<ReturnType<typeof readActivityRows>>,
  type: string,
): number {
  return rows.filter((row) => row.type === type).length;
}

describe("processAiAnalysis success path", () => {
  it("transitions pending→ready with one model call, activity, requester-only notification, and identifier-only pg_notify", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}]);
    mocks.push(mock);
    const listener = await listenForUpdates(testDb.databaseUrl);
    listeners.push(listener);

    await processAiAnalysis(
      {
        db: client.db,
        capability: configuredCapability(mock),
        logger: createTestLogger(),
      },
      { analysisId, isFinalAttempt: true },
    );

    const row = await readAnalysis(client, analysisId);
    expect(row?.status).toBe("ready");
    expect(row?.summary).toBe(SUMMARY_MARKER);
    expect(row?.errorCode).toBeNull();
    expect(row?.completedAt).not.toBeNull();
    expect(mock.requests).toHaveLength(1);

    const activity = await readActivityRows(client, seed.issueId);
    expect(countActivity(activity, "ai_analysis_completed")).toBe(1);

    const notifications = await readNotificationRows(client, seed.issueId);
    const completed = notifications.filter(
      (entry) => entry.type === "ai_analysis_completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.user_id).toBe(seed.userId);
    expect(completed[0]?.workspace_id).toBe(seed.workspaceId);
    expect(completed[0]?.project_id).toBe(seed.projectId);
    expect(
      notifications.some((entry) => entry.user_id === seed.otherUserId),
    ).toBe(false);

    const update = await waitFor(() => listener.payloads[0] ?? null);
    expect(update).toEqual({
      version: 1,
      type: "ai_analysis.ready",
      projectId: seed.projectId,
      issueId: seed.issueId,
      eventId: seed.eventId,
      analysisId,
    });
    // Identifiers only: no prompt, evidence, or model output crosses the wire.
    const serialized = JSON.stringify(update);
    expect(serialized).not.toContain(SUMMARY_MARKER);
    expect(serialized).not.toContain(ISSUE_MESSAGE_MARKER);
    expect(serialized).not.toContain("stacktrace");

    // Activity and notification rows carry ids and fixed copy only.
    const activitySerialized = JSON.stringify(activity);
    expect(activitySerialized).not.toContain(SUMMARY_MARKER);
    expect(activitySerialized).not.toContain(ISSUE_MESSAGE_MARKER);
    const notificationSerialized = JSON.stringify(completed);
    expect(notificationSerialized).not.toContain(SUMMARY_MARKER);
    expect(notificationSerialized).not.toContain(ISSUE_MESSAGE_MARKER);

    // The bounded bundle reaches the model: selected-occurrence semantics
    // exclude later same-session events and strip network query strings.
    const outbound = JSON.stringify(mock.requests[0]?.body);
    expect(outbound).toContain(ISSUE_MESSAGE_MARKER);
    expect(outbound).toContain("stack:1");
    expect(outbound).toContain("network:");
    expect(outbound).not.toContain(LATER_EVENT_MARKER);
    expect(outbound).not.toContain("token=secret");
  });

  it("prefers the persisted symbolicated stack when the enrichment mapped frames", async () => {
    const seed = await seedAiEvidence(client);
    await client.pool.query(
      `UPDATE events SET symbolication_json = $1 WHERE id = $2`,
      [
        JSON.stringify({
          status: "mapped",
          rawFrames: [
            {
              filename: "app.js",
              function: "submit",
              lineno: 10,
              colno: 5,
              inApp: true,
            },
          ],
          mappedFrames: [
            {
              filename: "app.js",
              source: "src/checkout.ts",
              function: "submit",
              name: "submitOrder",
              line: 42,
              column: 7,
              inApplication: true,
              mapped: true,
            },
          ],
          mappedFrameCount: 1,
        }),
        seed.eventId,
      ],
    );
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}]);
    mocks.push(mock);

    await processAiAnalysis(
      {
        db: client.db,
        capability: configuredCapability(mock),
        logger: createTestLogger(),
      },
      { analysisId, isFinalAttempt: true },
    );

    const outbound = JSON.stringify(mock.requests[0]?.body);
    expect(outbound).toContain("src/checkout.ts");
    expect((await readAnalysis(client, analysisId))?.status).toBe("ready");
  });

  it("never logs prompts, evidence, or raw model output", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}]);
    mocks.push(mock);
    const capture = createCapturingLogger();

    await processAiAnalysis(
      {
        db: client.db,
        capability: configuredCapability(mock),
        logger: capture.logger,
      },
      { analysisId, isFinalAttempt: true },
    );

    const logged = JSON.stringify(capture.entries);
    expect(logged).toContain(analysisId);
    expect(logged).not.toContain(SUMMARY_MARKER);
    expect(logged).not.toContain(ISSUE_MESSAGE_MARKER);
    expect(logged).not.toContain("UNTRUSTED_EVIDENCE");
    expect(logged).not.toContain("allowedRefs");
    expect(logged).not.toContain("suspectedCause");
  });
});

describe("processAiAnalysis idempotency", () => {
  it("does not repeat the model call, activity, or notification on a terminal retry", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}, {}]);
    mocks.push(mock);

    const deps = {
      db: client.db,
      capability: configuredCapability(mock),
      logger: createTestLogger(),
    };
    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    const first = await readAnalysis(client, analysisId);
    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    const second = await readAnalysis(client, analysisId);

    expect(mock.requests).toHaveLength(1);
    expect(second?.status).toBe("ready");
    expect(second?.summary).toBe(first?.summary);
    expect(
      countActivity(
        await readActivityRows(client, seed.issueId),
        "ai_analysis_completed",
      ),
    ).toBe(1);
    expect(
      (await readNotificationRows(client, seed.issueId)).filter(
        (entry) => entry.type === "ai_analysis_completed",
      ),
    ).toHaveLength(1);
  });

  it("resolves concurrent duplicate jobs into one effective analysis", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}, {}]);
    mocks.push(mock);
    const deps = {
      db: client.db,
      capability: configuredCapability(mock),
      logger: createTestLogger(),
    };

    await Promise.all([
      processAiAnalysis(deps, { analysisId, isFinalAttempt: false }),
      processAiAnalysis(deps, { analysisId, isFinalAttempt: false }),
    ]);

    const row = await readAnalysis(client, analysisId);
    expect(row?.status).toBe("ready");
    expect(
      countActivity(
        await readActivityRows(client, seed.issueId),
        "ai_analysis_completed",
      ),
    ).toBe(1);
    expect(
      (await readNotificationRows(client, seed.issueId)).filter(
        (entry) => entry.type === "ai_analysis_completed",
      ),
    ).toHaveLength(1);
    expect(mock.requests.length).toBeLessThanOrEqual(2);
  });

  it("is a no-op for an unknown analysis id", async () => {
    await expect(
      processAiAnalysis(
        {
          db: client.db,
          capability: { state: "disabled" },
          logger: createTestLogger(),
        },
        { analysisId: randomUUID(), isFinalAttempt: true },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("processAiAnalysis retry taxonomy", () => {
  it("rethrows a transient timeout without side effects, then fails safely on the final attempt", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const slowMock = await startMock([{ delayMs: 300 }, { delayMs: 300 }]);
    mocks.push(slowMock);
    const listener = await listenForUpdates(testDb.databaseUrl);
    listeners.push(listener);
    const deps = {
      db: client.db,
      capability: configuredCapability(slowMock, 50),
      logger: createTestLogger(),
    };

    await expect(
      processAiAnalysis(deps, { analysisId, isFinalAttempt: false }),
    ).rejects.toThrow();
    expect((await readAnalysis(client, analysisId))?.status).toBe("pending");
    expect(
      countActivity(
        await readActivityRows(client, seed.issueId),
        "ai_analysis_failed",
      ),
    ).toBe(0);

    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    const failed = await readAnalysis(client, analysisId);
    expect(failed?.status).toBe("failed");
    expect(failed?.errorCode).toBe("AI_ANALYSIS_TIMEOUT");
    expect(failed?.summary).toBeNull();

    const notifications = await readNotificationRows(client, seed.issueId);
    const failureNotes = notifications.filter(
      (entry) => entry.type === "ai_analysis_failed",
    );
    expect(failureNotes).toHaveLength(1);
    expect(failureNotes[0]?.user_id).toBe(seed.userId);
    expect(
      countActivity(
        await readActivityRows(client, seed.issueId),
        "ai_analysis_failed",
      ),
    ).toBe(1);

    const update = await waitFor(() => listener.payloads[0] ?? null);
    expect(update).toEqual({
      version: 1,
      type: "ai_analysis.failed",
      projectId: seed.projectId,
      issueId: seed.issueId,
      eventId: seed.eventId,
      analysisId,
    });
    expect(JSON.stringify(update)).not.toContain(SUMMARY_MARKER);
  });

  it("keeps other jobs unaffected while one provider is timing out", async () => {
    const slowSeed = await seedAiEvidence(client);
    const healthySeed = await seedAiEvidence(client);
    const slowId = await createAnalysis(client, slowSeed);
    const healthyId = await createAnalysis(client, healthySeed);
    const slowMock = await startMock([{ delayMs: 300 }, { delayMs: 300 }]);
    const fastMock = await startMock([{}]);
    mocks.push(slowMock, fastMock);

    await expect(
      processAiAnalysis(
        {
          db: client.db,
          capability: configuredCapability(slowMock, 50),
          logger: createTestLogger(),
        },
        { analysisId: slowId, isFinalAttempt: false },
      ),
    ).rejects.toThrow();

    await processAiAnalysis(
      {
        db: client.db,
        capability: configuredCapability(fastMock),
        logger: createTestLogger(),
      },
      { analysisId: healthyId, isFinalAttempt: true },
    );
    expect((await readAnalysis(client, healthyId))?.status).toBe("ready");
    expect(fastMock.requests).toHaveLength(1);
  });

  it.each([
    [500, "AI_ANALYSIS_PROVIDER_UNAVAILABLE"],
    [429, "AI_ANALYSIS_PROVIDER_UNAVAILABLE"],
    [408, "AI_ANALYSIS_PROVIDER_UNAVAILABLE"],
  ])(
    "treats HTTP %i as transient and fails safely only on the final attempt (%s)",
    async (status, errorCode) => {
      const seed = await seedAiEvidence(client);
      const analysisId = await createAnalysis(client, seed);
      const mock = await startMock([{ status }, { status }]);
      mocks.push(mock);
      const deps = {
        db: client.db,
        capability: configuredCapability(mock),
        logger: createTestLogger(),
      };

      await expect(
        processAiAnalysis(deps, { analysisId, isFinalAttempt: false }),
      ).rejects.toThrow();
      expect((await readAnalysis(client, analysisId))?.status).toBe("pending");

      await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
      expect((await readAnalysis(client, analysisId))?.errorCode).toBe(
        errorCode,
      );
    },
  );

  it("treats connection refusal as transient and fails safely on the final attempt", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const deps = {
      db: client.db,
      capability: {
        state: "configured",
        baseUrl: "http://127.0.0.1:1",
        model: "test-model",
        timeoutMs: 500,
      } satisfies OllamaCapability,
      logger: createTestLogger(),
    };

    await expect(
      processAiAnalysis(deps, { analysisId, isFinalAttempt: false }),
    ).rejects.toThrow();
    expect((await readAnalysis(client, analysisId))?.status).toBe("pending");

    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    expect((await readAnalysis(client, analysisId))?.errorCode).toBe(
      "AI_ANALYSIS_PROVIDER_UNAVAILABLE",
    );
  });

  it.each([
    [
      "invalid structured content",
      JSON.stringify({
        message: { role: "assistant", content: "not json at all" },
      }),
    ],
    [
      "wrong schema",
      JSON.stringify({
        message: {
          role: "assistant",
          content: JSON.stringify({ ...validOutput, summary: "" }),
        },
      }),
    ],
    [
      "unknown evidence refs",
      JSON.stringify({
        message: {
          role: "assistant",
          content: JSON.stringify({
            ...validOutput,
            evidence: [{ ref: "stack:999", reason: "bad ref" }],
          }),
        },
      }),
    ],
  ])(
    "fails deterministically after the adapter's single structured retry for %s",
    async (_name, content) => {
      const seed = await seedAiEvidence(client);
      const analysisId = await createAnalysis(client, seed);
      const mock = await startMock([{ body: content }, { body: content }]);
      mocks.push(mock);

      await processAiAnalysis(
        {
          db: client.db,
          capability: configuredCapability(mock),
          logger: createTestLogger(),
        },
        { analysisId, isFinalAttempt: true },
      );

      const row = await readAnalysis(client, analysisId);
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe("AI_ANALYSIS_RESPONSE_INVALID");
      expect(mock.requests).toHaveLength(2);
      expect(
        countActivity(
          await readActivityRows(client, seed.issueId),
          "ai_analysis_failed",
        ),
      ).toBe(1);
    },
  );

  it.each([
    [{ state: "disabled" } satisfies OllamaCapability, "AI_ANALYSIS_DISABLED"],
    [
      {
        state: "misconfigured",
        code: "OLLAMA_URL_INVALID",
        reason: "bad url",
      } satisfies OllamaCapability,
      "AI_ANALYSIS_MISCONFIGURED",
    ],
  ])(
    "fails deterministically without any provider call when the capability is %s",
    async (capability, errorCode) => {
      const seed = await seedAiEvidence(client);
      const analysisId = await createAnalysis(client, seed);

      await processAiAnalysis(
        { db: client.db, capability, logger: createTestLogger() },
        { analysisId, isFinalAttempt: true },
      );

      const row = await readAnalysis(client, analysisId);
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe(errorCode);
    },
  );

  it("fails deterministically when the stored evidence reference is gone", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed, { eventId: null });

    await processAiAnalysis(
      {
        db: client.db,
        capability: { state: "disabled" },
        logger: createTestLogger(),
      },
      { analysisId, isFinalAttempt: true },
    );

    const row = await readAnalysis(client, analysisId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("AI_ANALYSIS_INVALID_EVIDENCE");
    expect(
      (await readNotificationRows(client, seed.issueId)).filter(
        (entry) => entry.type === "ai_analysis_failed",
      ),
    ).toHaveLength(1);
  });
});

describe("processAiAnalysis outbox crash window", () => {
  it("does not call the provider again when the analysis is already terminal", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{}, {}]);
    mocks.push(mock);

    // Crash window: the job is durable but the outbox row is undispatched.
    await boss.send(
      GENERATE_AI_ANALYSIS_QUEUE,
      buildGenerateAiAnalysisJob(analysisId),
      generateAiAnalysisSendOptions(analysisId),
    );
    await client.pool.query(
      `UPDATE ai_analysis_outbox SET dispatched_at = NULL WHERE analysis_id = $1`,
      [analysisId],
    );

    const deps = {
      db: client.db,
      capability: configuredCapability(mock),
      logger: createTestLogger(),
    };
    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    expect((await readAnalysis(client, analysisId))?.status).toBe("ready");
    expect(mock.requests).toHaveLength(1);

    // A duplicate job replay after the terminal transition changes nothing.
    await processAiAnalysis(deps, { analysisId, isFinalAttempt: true });
    expect(mock.requests).toHaveLength(1);
    expect(
      countActivity(
        await readActivityRows(client, seed.issueId),
        "ai_analysis_completed",
      ),
    ).toBe(1);
  });
});

describe("processAiAnalysis pg-boss retry exhaustion", () => {
  it("retries a transient provider failure and marks the analysis failed on the final attempt", async () => {
    const seed = await seedAiEvidence(client);
    const analysisId = await createAnalysis(client, seed);
    const mock = await startMock([{ status: 500 }, { status: 500 }]);
    mocks.push(mock);

    await boss.send(
      GENERATE_AI_ANALYSIS_QUEUE,
      buildGenerateAiAnalysisJob(analysisId),
      generateAiAnalysisSendOptions(analysisId),
    );
    const handler = createGenerateAiAnalysisJobHandler({
      db: client.db,
      capability: configuredCapability(mock),
      logger: createTestLogger(),
    });
    await boss.work(
      GENERATE_AI_ANALYSIS_QUEUE,
      {
        batchSize: 1,
        pollingIntervalSeconds: 0.5,
        localConcurrency: 1,
        includeMetadata: true,
      },
      handler,
    );
    try {
      const failed = await waitFor(async () => {
        const row = await readAnalysis(client, analysisId);
        return row?.status === "failed" ? row : null;
      }, 40_000);
      expect(failed.errorCode).toBe("AI_ANALYSIS_PROVIDER_UNAVAILABLE");
      expect(mock.requests).toHaveLength(2);
      expect(
        (await readNotificationRows(client, seed.issueId)).filter(
          (entry) => entry.type === "ai_analysis_failed",
        ),
      ).toHaveLength(1);
    } finally {
      await boss.offWork(GENERATE_AI_ANALYSIS_QUEUE, { wait: true });
    }
  }, 60_000);

  it("rejects an invalid job payload before touching the database", async () => {
    const handler = createGenerateAiAnalysisJobHandler({
      db: client.db,
      capability: { state: "disabled" },
      logger: createTestLogger(),
    });
    await expect(
      handler([
        {
          id: randomUUID(),
          name: GENERATE_AI_ANALYSIS_QUEUE,
          data: { version: 1, analysisId: "not-a-uuid" },
          expireInSeconds: 120,
          heartbeatSeconds: null,
          signal: new AbortController().signal,
        } as unknown as Parameters<typeof handler>[0][number],
      ]),
    ).rejects.toThrow();
  });
});
