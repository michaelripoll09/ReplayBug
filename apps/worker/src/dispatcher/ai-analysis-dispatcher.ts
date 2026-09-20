import type { PgBoss } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import {
  AiAnalysisRepo,
  type Database,
  type PendingAiAnalysisOutboxItem,
} from "@replaybug/db";
import {
  GENERATE_AI_ANALYSIS_QUEUE,
  buildGenerateAiAnalysisJob,
  generateAiAnalysisSendOptions,
} from "../queues/ai-analysis.js";

/**
 * Transactional AI analysis outbox dispatcher.
 *
 * A pass claims a bounded batch of undispatched rows with
 * `FOR UPDATE SKIP LOCKED`, publishes each row to pg-boss outside the claim
 * transaction (stable job id per analysis makes re-publish safe), then marks
 * the row dispatched in a fresh transaction. Publish failures stay pending
 * with a sanitized bounded `last_error` for the next pass. Concurrent
 * dispatchers skip each other's locked rows.
 */

export interface AiAnalysisPublisher {
  publishAiAnalysis(analysisId: string): Promise<string | null>;
}

export function createPgBossAiAnalysisPublisher(
  boss: PgBoss,
): AiAnalysisPublisher {
  return {
    publishAiAnalysis(analysisId: string): Promise<string | null> {
      return boss.send(
        GENERATE_AI_ANALYSIS_QUEUE,
        buildGenerateAiAnalysisJob(analysisId),
        generateAiAnalysisSendOptions(analysisId),
      );
    },
  };
}

export interface AiAnalysisDispatchResult {
  claimed: number;
  dispatched: number;
  deduplicated: number;
  failed: number;
}

export interface AiAnalysisReconciliationSummary extends AiAnalysisDispatchResult {
  stalePending: number;
}

/**
 * Bounds a stored failure message so the outbox never accumulates unbounded
 * or payload-bearing error text.
 */
export function sanitizeAiAnalysisOutboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

async function publishClaimedAiAnalysisItems(
  db: Database,
  items: readonly PendingAiAnalysisOutboxItem[],
  publisher: AiAnalysisPublisher,
  logger: Logger,
): Promise<AiAnalysisDispatchResult> {
  let dispatched = 0;
  let deduplicated = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const jobId = await publisher.publishAiAnalysis(item.analysisId);
      if (jobId === null) {
        deduplicated++;
      }
      await db.transaction(async (tx) => {
        await AiAnalysisRepo.markAiAnalysisOutboxDispatched(
          tx,
          item.analysisId,
        );
      });
      dispatched++;
      logger.debug(
        {
          analysisId: item.analysisId,
          jobId,
          attempt: item.attemptCount,
          result: jobId === null ? "deduplicated" : "published",
        },
        "AI analysis outbox row dispatched",
      );
    } catch (error) {
      failed++;
      const sanitized = sanitizeAiAnalysisOutboxError(error);
      await db.transaction(async (tx) => {
        await AiAnalysisRepo.recordAiAnalysisOutboxFailure(
          tx,
          item.analysisId,
          sanitized,
        );
      });
      logger.warn(
        {
          analysisId: item.analysisId,
          attempt: item.attemptCount + 1,
          result: "publish-failed",
          error: sanitized,
        },
        "AI analysis outbox publish failed; row remains pending for retry",
      );
    }
  }

  return { claimed: items.length, dispatched, deduplicated, failed };
}

export async function dispatchAiAnalysisOutboxBatch(
  db: Database,
  publisher: AiAnalysisPublisher,
  batchSize: number,
  logger?: Pick<Logger, "debug" | "warn">,
): Promise<AiAnalysisDispatchResult> {
  const claimed = await db.transaction(async (tx) => {
    return AiAnalysisRepo.claimPendingAiAnalysisOutboxBatch(tx, batchSize);
  });
  if (claimed.length === 0) {
    return { claimed: 0, dispatched: 0, deduplicated: 0, failed: 0 };
  }
  return publishClaimedAiAnalysisItems(
    db,
    claimed,
    publisher,
    (logger ?? NOOP_LOGGER) as Logger,
  );
}

export async function reconcileAiAnalysisOutbox(
  db: Database,
  publisher: AiAnalysisPublisher,
  options: {
    batchSize: number;
    staleAfterMs: number;
    logger: Logger;
  },
): Promise<AiAnalysisReconciliationSummary> {
  const staleBefore = new Date(Date.now() - options.staleAfterMs);
  const stale = await AiAnalysisRepo.listStaleAiAnalysisOutbox(
    db,
    staleBefore,
    options.batchSize,
  );
  if (stale.length === 0) {
    return {
      claimed: 0,
      dispatched: 0,
      deduplicated: 0,
      failed: 0,
      stalePending: 0,
    };
  }

  const claimed = await db.transaction(async (tx) => {
    return AiAnalysisRepo.claimStaleAiAnalysisOutboxBatch(
      tx,
      staleBefore,
      options.batchSize,
    );
  });
  if (claimed.length === 0) {
    return {
      claimed: 0,
      dispatched: 0,
      deduplicated: 0,
      failed: 0,
      stalePending: stale.length,
    };
  }

  const result = await publishClaimedAiAnalysisItems(
    db,
    claimed,
    publisher,
    options.logger,
  );

  options.logger.warn(
    {
      aiAnalysisOutboxStalePending: stale.length,
      aiAnalysisOutboxDispatched: result.dispatched,
      aiAnalysisOutboxDeduplicated: result.deduplicated,
      aiAnalysisOutboxFailed: result.failed,
    },
    "AI analysis outbox reconciliation retried stale rows",
  );

  return { ...result, stalePending: stale.length };
}

export interface AiAnalysisDispatcherDeps {
  db: Database;
  publisher: AiAnalysisPublisher;
  logger: Logger;
  batchSize: number;
  pollMs: number;
}

export interface AiAnalysisDispatcherHandle {
  /** Runs exactly one bounded dispatch pass (used by tests and diagnostics). */
  runOnce(): Promise<AiAnalysisDispatchResult>;
  /** Stops scheduling and waits for any in-flight pass. */
  stop(): Promise<void>;
}

/** Upper bound on consecutive full-batch drains in one timer tick. */
const MAX_DRAIN_ITERATIONS = 10;

/**
 * Starts the AI analysis dispatcher loop. Passes never overlap: the next tick
 * is scheduled only after the current one settles, and a full batch triggers
 * a bounded immediate drain instead of a hot loop.
 */
export function startAiAnalysisDispatcher(
  deps: AiAnalysisDispatcherDeps,
): AiAnalysisDispatcherHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight !== null) {
      return;
    }
    inFlight = (async () => {
      try {
        let iterations = 0;
        let summary: AiAnalysisDispatchResult;
        do {
          summary = await dispatchAiAnalysisOutboxBatch(
            deps.db,
            deps.publisher,
            deps.batchSize,
            deps.logger,
          );
          if (summary.claimed > 0) {
            deps.logger.info(
              {
                aiAnalysisOutboxClaimed: summary.claimed,
                aiAnalysisOutboxDispatched: summary.dispatched,
                aiAnalysisOutboxDeduplicated: summary.deduplicated,
                aiAnalysisOutboxFailed: summary.failed,
              },
              "AI analysis outbox batch dispatched",
            );
          }
          iterations++;
        } while (
          !stopped &&
          summary.claimed === deps.batchSize &&
          iterations < MAX_DRAIN_ITERATIONS
        );
      } catch (error) {
        deps.logger.error(
          { err: error },
          "AI analysis outbox dispatcher pass failed; next pass will retry",
        );
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    scheduleNext(deps.pollMs);
  };

  scheduleNext(0);

  return {
    runOnce(): Promise<AiAnalysisDispatchResult> {
      return dispatchAiAnalysisOutboxBatch(
        deps.db,
        deps.publisher,
        deps.batchSize,
        deps.logger,
      );
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
    },
  };
}

export interface AiAnalysisReconciliationDeps {
  db: Database;
  publisher: AiAnalysisPublisher;
  logger: Logger;
  batchSize: number;
  intervalMs: number;
  staleAfterMs: number;
}

export interface AiAnalysisReconciliationHandle {
  runOnce(): Promise<AiAnalysisReconciliationSummary>;
  stop(): Promise<void>;
}

export function startAiAnalysisReconciliation(
  deps: AiAnalysisReconciliationDeps,
): AiAnalysisReconciliationHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const scheduleNext = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, deps.intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight !== null) {
      return;
    }
    inFlight = (async () => {
      try {
        await reconcileAiAnalysisOutbox(deps.db, deps.publisher, {
          batchSize: deps.batchSize,
          staleAfterMs: deps.staleAfterMs,
          logger: deps.logger,
        });
      } catch (error) {
        deps.logger.error(
          { err: error },
          "AI analysis outbox reconciliation pass failed; next pass will retry",
        );
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    scheduleNext();
  };

  scheduleNext();

  return {
    runOnce(): Promise<AiAnalysisReconciliationSummary> {
      return reconcileAiAnalysisOutbox(deps.db, deps.publisher, {
        batchSize: deps.batchSize,
        staleAfterMs: deps.staleAfterMs,
        logger: deps.logger,
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
    },
  };
}
