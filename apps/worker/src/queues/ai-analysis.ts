import type { Queue } from "pg-boss";
import {
  aiAnalysisJobPayloadSchema,
  type AiAnalysisJobPayload,
} from "@replaybug/contracts";
import type { WorkerConfig } from "../config.js";

/**
 * Job contract for optional local Ollama issue analysis.
 *
 * The payload is deliberately minimal and versioned: it carries only the
 * analysis id. The worker re-reads the analysis, issue, event and session
 * evidence from PostgreSQL, so pg-boss never stores telemetry evidence,
 * prompts, or model output, jobs stay small, and DB/job state cannot drift.
 */
export const GENERATE_AI_ANALYSIS_QUEUE = "replaybug.generate-ai-analysis";
export const GENERATE_AI_ANALYSIS_JOB_VERSION = 1;

/** Reuses the canonical AI-01 contract so the job shape cannot drift. */
export const generateAiAnalysisJobSchema = aiAnalysisJobPayloadSchema;
export type GenerateAiAnalysisJob = AiAnalysisJobPayload;

export function buildGenerateAiAnalysisJob(
  analysisId: string,
): GenerateAiAnalysisJob {
  return {
    version: GENERATE_AI_ANALYSIS_JOB_VERSION,
    analysisId,
  };
}

/**
 * Queue-level defaults inherited by every generate-ai-analysis job.
 * Bounded retries with backoff; poison jobs end in pg-boss's `failed`
 * state with output/retry metadata for inspection. Deterministic provider
 * and evidence failures never throw (they mark the row failed), so retries
 * only cover transient provider/network problems.
 */
export function generateAiAnalysisQueueOptions(
  config: WorkerConfig,
): Omit<Queue, "name"> {
  return {
    retryLimit: config.jobRetryLimit,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 60,
    expireInSeconds: 120,
  };
}

/**
 * Stable job identity: one generate-ai-analysis job id per analysis.
 *
 * pg-boss inserts with `ON CONFLICT DO NOTHING` on the (name, id) primary
 * key and returns null when the job already exists. A dispatcher crash
 * between publishing and marking the outbox row therefore re-publishes
 * safely: the second send is deduplicated, and the processor is idempotent
 * by DB state regardless.
 */
export function generateAiAnalysisSendOptions(analysisId: string): {
  id: string;
} {
  return { id: analysisId };
}
