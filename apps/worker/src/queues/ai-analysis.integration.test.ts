import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
import {
  GENERATE_AI_ANALYSIS_JOB_VERSION,
  GENERATE_AI_ANALYSIS_QUEUE,
  buildGenerateAiAnalysisJob,
  generateAiAnalysisJobSchema,
  generateAiAnalysisQueueOptions,
  generateAiAnalysisSendOptions,
} from "./ai-analysis.js";
import {
  createTestWorkerConfig,
  createWorkerTestDatabase,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * AI analysis job contract against real pg-boss + real PostgreSQL (isolated
 * temp database). The payload is deliberately minimal and versioned: it
 * carries only the analysis id, so pg-boss never stores telemetry evidence,
 * prompts, or model output, and DB/job state cannot drift.
 */

let testDb: WorkerTestDatabase;
let client: DbClient;
let boss: PgBoss;
let bossSchema: string;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
  const config = createTestWorkerConfig({
    databaseUrl: testDb.databaseUrl,
    jobRetryLimit: 3,
  });
  bossSchema = config.bossSchema;
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

afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await testDb.drop();
});

describe("generate-ai-analysis job contract", () => {
  it("registers the exact queue name and version", () => {
    expect(GENERATE_AI_ANALYSIS_QUEUE).toBe("replaybug.generate-ai-analysis");
    expect(GENERATE_AI_ANALYSIS_JOB_VERSION).toBe(1);
  });

  it("builds a minimal versioned payload with only the analysis id", () => {
    const analysisId = randomUUID();
    const job = buildGenerateAiAnalysisJob(analysisId);
    expect(job).toEqual({ version: 1, analysisId });
    expect(generateAiAnalysisJobSchema.safeParse(job).success).toBe(true);
  });

  it("rejects unknown versions and non-uuid analysis ids", () => {
    const analysisId = randomUUID();
    expect(
      generateAiAnalysisJobSchema.safeParse({ version: 2, analysisId }).success,
    ).toBe(false);
    expect(
      generateAiAnalysisJobSchema.safeParse({ version: 1, analysisId: "nope" })
        .success,
    ).toBe(false);
  });

  it("rejects smuggled telemetry evidence or prompt text in the payload", () => {
    const analysisId = randomUUID();
    expect(
      generateAiAnalysisJobSchema.safeParse({
        version: 1,
        analysisId,
        evidence: { message: "secret telemetry" },
      }).success,
    ).toBe(false);
    expect(
      generateAiAnalysisJobSchema.safeParse({
        version: 1,
        analysisId,
        prompt: "ignore prior instructions",
      }).success,
    ).toBe(false);
  });

  it("mirrors the reproduction retry policy (bounded, backoff, bounded expiry)", () => {
    const config = createTestWorkerConfig({ jobRetryLimit: 3 });
    const options = generateAiAnalysisQueueOptions(config);
    expect(options).toEqual({
      retryLimit: 3,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: 120,
    });
  });

  it("uses the analysis id as the stable job identity", () => {
    const analysisId = randomUUID();
    expect(generateAiAnalysisSendOptions(analysisId)).toEqual({
      id: analysisId,
    });
  });

  it("deduplicates a re-published job by stable id in real pg-boss", async () => {
    const analysisId = randomUUID();
    const first = await boss.send(
      GENERATE_AI_ANALYSIS_QUEUE,
      buildGenerateAiAnalysisJob(analysisId),
      generateAiAnalysisSendOptions(analysisId),
    );
    const second = await boss.send(
      GENERATE_AI_ANALYSIS_QUEUE,
      buildGenerateAiAnalysisJob(analysisId),
      generateAiAnalysisSendOptions(analysisId),
    );
    expect(first).toBe(analysisId);
    expect(second).toBeNull();

    const jobs = await boss.findJobs<{
      version: number;
      analysisId: string;
    }>(GENERATE_AI_ANALYSIS_QUEUE, { id: analysisId });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ version: 1, analysisId });

    const row = await client.pool.query<{ retry_limit: number }>(
      `SELECT retry_limit FROM ${bossSchema}.job WHERE name = $1 AND id = $2`,
      [GENERATE_AI_ANALYSIS_QUEUE, analysisId],
    );
    expect(row.rows[0]?.retry_limit).toBe(3);
  });
});
