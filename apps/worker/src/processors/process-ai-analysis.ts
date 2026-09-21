import type { JobWithMetadata } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import {
  AiAnalysisRepo,
  IssueActivityRepo,
  IssueRepo,
  NotificationRepo,
  ProjectRepo,
  notifyProjectIssueUpdate,
  type Database,
} from "@replaybug/db";
import type { AiAnalysisOutput } from "@replaybug/contracts";
import type { OllamaCapability } from "../config.js";
import {
  createOllamaProvider,
  ModelAnalysisError,
  type ModelAnalysisErrorCode,
} from "../ai/ollama.js";
import { AiEvidenceError, type BuiltAiEvidence } from "../ai/evidence.js";
import { AiEvidenceLoadError, loadAiEvidence } from "../ai/evidence-loader.js";
import type { AiAnalysisProvider } from "../ai/provider.js";
import { generateAiAnalysisJobSchema } from "../queues/ai-analysis.js";

export interface ProcessAiAnalysisDeps {
  db: Database;
  /** Operator-configured provider capability; disabled/misconfigured fail safely. */
  capability: OllamaCapability;
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug"> | undefined;
}

export interface ProcessAiAnalysisInput {
  analysisId: string;
  /**
   * True on pg-boss's last allowed attempt. Transient provider errors are
   * rethrown while retries remain, and only converted to a terminal failure
   * on the final attempt so the row never stays pending forever.
   */
  isFinalAttempt?: boolean;
}

/** Deterministic, non-retryable failure codes persisted on the analysis row. */
export type AiAnalysisErrorCode =
  | "AI_ANALYSIS_DISABLED"
  | "AI_ANALYSIS_MISCONFIGURED"
  | "AI_ANALYSIS_INVALID_EVIDENCE"
  | "AI_ANALYSIS_TIMEOUT"
  | "AI_ANALYSIS_PROVIDER_UNAVAILABLE"
  | "AI_ANALYSIS_PROVIDER_REJECTED"
  | "AI_ANALYSIS_RESPONSE_INVALID"
  | "AI_ANALYSIS_FAILED";

const ERROR_MESSAGE_MAX_LENGTH = 500;

/** Provider errors that pg-boss may retry with bounded backoff. */
const TRANSIENT_MODEL_ERRORS: ReadonlySet<ModelAnalysisErrorCode> = new Set([
  "MODEL_TIMEOUT",
  "MODEL_CONNECTION_FAILED",
  "MODEL_HTTP_TRANSIENT",
]);

const MODEL_ERROR_CODES: Record<ModelAnalysisErrorCode, AiAnalysisErrorCode> = {
  MODEL_DISABLED: "AI_ANALYSIS_DISABLED",
  MODEL_MISCONFIGURED: "AI_ANALYSIS_MISCONFIGURED",
  MODEL_CONFIG_INVALID: "AI_ANALYSIS_MISCONFIGURED",
  MODEL_TIMEOUT: "AI_ANALYSIS_TIMEOUT",
  MODEL_CONNECTION_FAILED: "AI_ANALYSIS_PROVIDER_UNAVAILABLE",
  MODEL_HTTP_TRANSIENT: "AI_ANALYSIS_PROVIDER_UNAVAILABLE",
  MODEL_HTTP_ERROR: "AI_ANALYSIS_PROVIDER_REJECTED",
  MODEL_ENVELOPE_INVALID: "AI_ANALYSIS_RESPONSE_INVALID",
  MODEL_RESPONSE_INVALID: "AI_ANALYSIS_RESPONSE_INVALID",
};

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

function notificationCopy(
  status: "ready" | "failed",
  errorCode: AiAnalysisErrorCode | null,
): { title: string; body: string } {
  if (status === "ready") {
    return {
      title: "AI analysis ready",
      body: "An AI hypothesis for this issue is ready to review. It is a suggestion, not a verified cause.",
    };
  }
  switch (errorCode) {
    case "AI_ANALYSIS_DISABLED":
      return {
        title: "AI analysis failed: not configured",
        body: "ReplayBug could not run the AI analysis because the local model is not configured.",
      };
    case "AI_ANALYSIS_MISCONFIGURED":
      return {
        title: "AI analysis failed: misconfigured",
        body: "ReplayBug could not run the AI analysis because the local model configuration is invalid.",
      };
    case "AI_ANALYSIS_INVALID_EVIDENCE":
      return {
        title: "AI analysis failed: evidence unavailable",
        body: "ReplayBug could not run the AI analysis because the referenced evidence is no longer available.",
      };
    case "AI_ANALYSIS_TIMEOUT":
      return {
        title: "AI analysis failed: timed out",
        body: "ReplayBug could not complete the AI analysis because the local model did not respond in time.",
      };
    case "AI_ANALYSIS_PROVIDER_UNAVAILABLE":
      return {
        title: "AI analysis failed: provider unavailable",
        body: "ReplayBug could not complete the AI analysis because the local model was unavailable.",
      };
    case "AI_ANALYSIS_PROVIDER_REJECTED":
      return {
        title: "AI analysis failed: provider rejected",
        body: "ReplayBug could not complete the AI analysis because the local model rejected the request.",
      };
    case "AI_ANALYSIS_RESPONSE_INVALID":
      return {
        title: "AI analysis failed: invalid response",
        body: "ReplayBug could not use the AI response because it did not match the required structured format.",
      };
    default:
      return {
        title: "AI analysis failed",
        body: "ReplayBug could not complete the AI analysis for this issue.",
      };
  }
}

interface TerminalContext {
  analysisId: string;
  issueId: string;
  projectId: string;
  workspaceId: string;
  eventId: string | null;
  requestedByUserId: string | null;
  model: string;
  analysisVersion: string;
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">;
  startedAt: number;
}

async function applyTerminalReady(
  deps: ProcessAiAnalysisDeps,
  ctx: TerminalContext,
  result: AiAnalysisOutput,
): Promise<void> {
  const transitioned = await deps.db.transaction(async (tx) => {
    const locked = await AiAnalysisRepo.lockPendingAiAnalysisById(
      tx,
      ctx.analysisId,
    );
    if (locked === undefined) {
      return false;
    }
    const updated = await AiAnalysisRepo.markAiAnalysisReady(
      tx,
      ctx.analysisId,
      result,
    );
    if (updated === undefined) {
      return false;
    }
    await IssueActivityRepo.insertIssueActivity(tx, {
      issueId: ctx.issueId,
      actorUserId: null,
      type: "ai_analysis_completed",
      metadataJson: {
        analysisId: ctx.analysisId,
        ...(ctx.eventId !== null ? { eventId: ctx.eventId } : {}),
        model: ctx.model,
        analysisVersion: ctx.analysisVersion,
      },
    });
    if (ctx.requestedByUserId !== null) {
      const copy = notificationCopy("ready", null);
      await NotificationRepo.insertNotification(tx, {
        userId: ctx.requestedByUserId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        issueId: ctx.issueId,
        type: "ai_analysis_completed",
        title: copy.title,
        body: copy.body,
      });
    }
    await notifyProjectIssueUpdate(tx, {
      version: 1,
      type: "ai_analysis.ready",
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      ...(ctx.eventId !== null ? { eventId: ctx.eventId } : {}),
      analysisId: ctx.analysisId,
    });
    return true;
  });

  ctx.logger.info(
    {
      analysisId: ctx.analysisId,
      issueId: ctx.issueId,
      projectId: ctx.projectId,
      eventId: ctx.eventId,
      model: ctx.model,
      status: "ready",
      transitioned,
      durationMs: Date.now() - ctx.startedAt,
    },
    "AI analysis completed",
  );
}

async function applyTerminalFailure(
  deps: ProcessAiAnalysisDeps,
  ctx: TerminalContext,
  input: { errorCode: AiAnalysisErrorCode; errorMessage: string },
): Promise<void> {
  const sanitized = sanitizeErrorMessage(input.errorMessage);
  const message = sanitized.length > 0 ? sanitized : "AI analysis failed.";
  const transitioned = await deps.db.transaction(async (tx) => {
    const locked = await AiAnalysisRepo.lockPendingAiAnalysisById(
      tx,
      ctx.analysisId,
    );
    if (locked === undefined) {
      return false;
    }
    const updated = await AiAnalysisRepo.markAiAnalysisFailed(
      tx,
      ctx.analysisId,
      { errorCode: input.errorCode, errorMessage: message },
    );
    if (updated === undefined) {
      return false;
    }
    await IssueActivityRepo.insertIssueActivity(tx, {
      issueId: ctx.issueId,
      actorUserId: null,
      type: "ai_analysis_failed",
      metadataJson: {
        analysisId: ctx.analysisId,
        ...(ctx.eventId !== null ? { eventId: ctx.eventId } : {}),
        model: ctx.model,
        analysisVersion: ctx.analysisVersion,
        errorCode: input.errorCode,
      },
    });
    if (ctx.requestedByUserId !== null) {
      const copy = notificationCopy("failed", input.errorCode);
      await NotificationRepo.insertNotification(tx, {
        userId: ctx.requestedByUserId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        issueId: ctx.issueId,
        type: "ai_analysis_failed",
        title: copy.title,
        body: copy.body,
      });
    }
    await notifyProjectIssueUpdate(tx, {
      version: 1,
      type: "ai_analysis.failed",
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      ...(ctx.eventId !== null ? { eventId: ctx.eventId } : {}),
      analysisId: ctx.analysisId,
    });
    return true;
  });

  ctx.logger.info(
    {
      analysisId: ctx.analysisId,
      issueId: ctx.issueId,
      projectId: ctx.projectId,
      eventId: ctx.eventId,
      model: ctx.model,
      status: "failed",
      errorCode: input.errorCode,
      transitioned,
      durationMs: Date.now() - ctx.startedAt,
    },
    "AI analysis failed deterministically",
  );
}

/**
 * Runs one AI analysis attempt.
 *
 * Flow:
 * 1. Load the row with no lock. Missing rows no-op (deleted after dispatch);
 *    terminal ready/failed rows no-op (idempotent retry, no second model call).
 * 2. Reject a disabled/misconfigured capability deterministically BEFORE any
 *    evidence work or provider call.
 * 3. Load issue/event/session evidence through existing repositories and
 *    build the sanitized bounded bundle (same selected-occurrence semantics as
 *    issue detail and reproduction generation).
 * 4. Call the Ollama provider OUTSIDE any transaction, then transition in one
 *    locked transaction with a terminal recheck, activity, requester-only
 *    notification, and identifier-only pg_notify.
 *
 * Transient provider errors are rethrown while retries remain (pg-boss
 * bounded retry) and converted to a terminal failure on the final attempt.
 * Deterministic problems never throw — they mark the row failed once.
 *
 * Logs carry ids/duration/status/errorCode only — never prompts, evidence,
 * model output, or provider URLs.
 */
export async function processAiAnalysis(
  deps: ProcessAiAnalysisDeps,
  input: ProcessAiAnalysisInput,
): Promise<void> {
  const logger = deps.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const startedAt = Date.now();
  const { analysisId } = input;
  const isFinalAttempt = input.isFinalAttempt ?? false;

  const preloaded = await AiAnalysisRepo.findAiAnalysisById(
    deps.db,
    analysisId,
  );
  if (preloaded === undefined) {
    logger.info({ analysisId, result: "not-found" }, "AI analysis no-op");
    return;
  }
  if (preloaded.status === "ready" || preloaded.status === "failed") {
    logger.info(
      { analysisId, result: preloaded.status },
      "AI analysis already terminal; no-op",
    );
    return;
  }

  const issue = await IssueRepo.findIssueById(deps.db, preloaded.issueId);
  if (issue === undefined) {
    throw new Error(`AI analysis issue not found for ${analysisId}`);
  }
  const project = await ProjectRepo.findProjectById(deps.db, issue.projectId);
  if (project === undefined) {
    throw new Error(`AI analysis project not found for ${analysisId}`);
  }

  const ctx: TerminalContext = {
    analysisId,
    issueId: issue.id,
    projectId: project.id,
    workspaceId: project.workspaceId,
    eventId: preloaded.eventId,
    requestedByUserId: preloaded.requestedByUserId,
    model: preloaded.model,
    analysisVersion: preloaded.analysisVersion,
    logger,
    startedAt,
  };

  if (ctx.eventId === null) {
    await applyTerminalFailure(deps, ctx, {
      errorCode: "AI_ANALYSIS_INVALID_EVIDENCE",
      errorMessage: "The occurrence for this analysis is no longer available.",
    });
    return;
  }

  let evidence: BuiltAiEvidence;
  try {
    evidence = await loadAiEvidence(deps.db, ctx.eventId);
  } catch (error) {
    if (
      error instanceof AiEvidenceLoadError ||
      error instanceof AiEvidenceError
    ) {
      await applyTerminalFailure(deps, ctx, {
        errorCode: "AI_ANALYSIS_INVALID_EVIDENCE",
        errorMessage: "The session evidence for this analysis is unavailable.",
      });
      return;
    }
    throw error;
  }

  if (deps.capability.state !== "configured") {
    await applyTerminalFailure(deps, ctx, {
      errorCode:
        deps.capability.state === "disabled"
          ? "AI_ANALYSIS_DISABLED"
          : "AI_ANALYSIS_MISCONFIGURED",
      errorMessage:
        deps.capability.state === "disabled"
          ? "AI analysis is disabled."
          : "AI analysis is misconfigured.",
    });
    return;
  }

  let provider: AiAnalysisProvider;
  try {
    provider = createOllamaProvider(deps.capability);
  } catch (error) {
    if (error instanceof ModelAnalysisError) {
      await applyTerminalFailure(deps, ctx, {
        errorCode: MODEL_ERROR_CODES[error.code],
        errorMessage: error.message,
      });
      return;
    }
    throw error;
  }

  const providerStartedAt = Date.now();
  let result: AiAnalysisOutput;
  try {
    result = await provider.analyze({
      evidenceJson: evidence.serialized,
      allowedRefs: evidence.allowedRefs,
    });
  } catch (error) {
    if (error instanceof ModelAnalysisError) {
      const errorCode = MODEL_ERROR_CODES[error.code];
      logger.warn(
        {
          analysisId,
          issueId: ctx.issueId,
          eventId: ctx.eventId,
          model: ctx.model,
          status: "provider-error",
          errorCode,
          durationMs: Date.now() - providerStartedAt,
          isFinalAttempt,
        },
        "AI analysis provider call failed",
      );
      if (TRANSIENT_MODEL_ERRORS.has(error.code) && !isFinalAttempt) {
        throw error;
      }
      await applyTerminalFailure(deps, ctx, {
        errorCode,
        errorMessage: error.message,
      });
      return;
    }
    throw error;
  }

  await applyTerminalReady(deps, ctx, result);
}

/**
 * pg-boss consumer for `replaybug.generate-ai-analysis`.
 *
 * Validates the versioned job payload with Zod, derives the final-attempt flag
 * from pg-boss retry metadata, and delegates to `processAiAnalysis`. Thrown
 * errors become pg-boss failures (bounded retries, then terminal `failed`);
 * deterministic problems never throw — they mark the row failed.
 */
export function createGenerateAiAnalysisJobHandler(
  deps: ProcessAiAnalysisDeps & { logger: Logger },
): (jobs: JobWithMetadata<unknown>[]) => Promise<void> {
  return async function handleGenerateAiAnalysisJobs(
    jobs: JobWithMetadata<unknown>[],
  ): Promise<void> {
    for (const job of jobs) {
      const parsed = generateAiAnalysisJobSchema.safeParse(job.data);
      if (!parsed.success) {
        deps.logger.error(
          { jobId: job.id, jobName: job.name },
          "generate-ai-analysis job payload failed contract validation",
        );
        throw new Error("invalid replaybug.generate-ai-analysis job payload");
      }
      const { analysisId } = parsed.data;
      const isFinalAttempt = job.retryCount >= job.retryLimit;
      const startedAt = Date.now();
      try {
        await processAiAnalysis(deps, { analysisId, isFinalAttempt });
        deps.logger.info(
          {
            jobId: job.id,
            jobName: job.name,
            analysisId,
            retryCount: job.retryCount,
            durationMs: Date.now() - startedAt,
          },
          "generate-ai-analysis completed",
        );
      } catch (error) {
        deps.logger.error(
          {
            jobId: job.id,
            jobName: job.name,
            analysisId,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            durationMs: Date.now() - startedAt,
            err: error,
          },
          "generate-ai-analysis failed; pg-boss will retry or fail the job",
        );
        throw error;
      }
    }
  };
}
