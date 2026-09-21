import type { PgBoss } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import {
  claimPendingReproductionOutboxBatch,
  claimStaleReproductionOutboxBatch,
  listStaleReproductionOutbox,
  markReproductionOutboxDispatched,
  recordReproductionOutboxFailure,
  type Database,
  type PendingReproductionOutboxItem,
} from "@replaybug/db";
import {
  GENERATE_REPRODUCTION_QUEUE,
  buildGenerateReproductionJob,
  generateReproductionSendOptions,
} from "../queues/reproduction.js";

/**
 * Transactional reproduction outbox dispatcher.
 *
 * A pass claims a bounded batch of undispatched rows with
 * `FOR UPDATE SKIP LOCKED`, publishes each row to pg-boss outside the
 * claim transaction (stable job id per reproduction makes re-publish safe),
 * then marks the row dispatched in a fresh transaction. Publish failures
 * stay pending with a sanitized bounded `last_error` for the next pass.
 * Concurrent dispatchers skip each other's locked rows.
 */

export interface ReproductionPublisher {
  publishReproduction(reproductionId: string): Promise<string | null>;
}

export function createPgBossReproductionPublisher(
  boss: PgBoss,
): ReproductionPublisher {
  return {
    publishReproduction(reproductionId: string): Promise<string | null> {
      return boss.send(
        GENERATE_REPRODUCTION_QUEUE,
        buildGenerateReproductionJob(reproductionId),
        generateReproductionSendOptions(reproductionId),
      );
    },
  };
}

export interface ReproductionDispatchResult {
  claimed: number;
  dispatched: number;
  deduplicated: number;
  failed: number;
}

export interface ReproductionReconciliationSummary extends ReproductionDispatchResult {
  stalePending: number;
}

/**
 * Bounds a stored failure message so the outbox never accumulates unbounded
 * or payload-bearing error text.
 */
export function sanitizeReproductionOutboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

async function publishClaimedReproductionItems(
  db: Database,
  items: readonly PendingReproductionOutboxItem[],
  publisher: ReproductionPublisher,
  logger: Logger,
): Promise<ReproductionDispatchResult> {
  let dispatched = 0;
  let deduplicated = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const jobId = await publisher.publishReproduction(item.reproductionId);
      if (jobId === null) {
        deduplicated++;
      }
      await db.transaction(async (tx) => {
        await markReproductionOutboxDispatched(tx, item.reproductionId);
      });
      dispatched++;
      logger.debug(
        {
          reproductionOutboxId: item.reproductionId,
          jobId,
          attempt: item.attemptCount,
          result: jobId === null ? "deduplicated" : "published",
        },
        "reproduction outbox row dispatched",
      );
    } catch (error) {
      failed++;
      const sanitized = sanitizeReproductionOutboxError(error);
      await db.transaction(async (tx) => {
        await recordReproductionOutboxFailure(
          tx,
          item.reproductionId,
          sanitized,
        );
      });
      logger.warn(
        {
          reproductionOutboxId: item.reproductionId,
          attempt: item.attemptCount + 1,
          result: "publish-failed",
          error: sanitized,
        },
        "reproduction outbox publish failed; row remains pending for retry",
      );
    }
  }

  return { claimed: items.length, dispatched, deduplicated, failed };
}

export async function dispatchReproductionOutboxBatch(
  db: Database,
  publisher: ReproductionPublisher,
  batchSize: number,
  logger?: Pick<Logger, "debug" | "warn">,
): Promise<ReproductionDispatchResult> {
  const claimed = await db.transaction(async (tx) => {
    return claimPendingReproductionOutboxBatch(tx, batchSize);
  });
  if (claimed.length === 0) {
    return { claimed: 0, dispatched: 0, deduplicated: 0, failed: 0 };
  }
  const noop: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return publishClaimedReproductionItems(
    db,
    claimed,
    publisher,
    (logger ?? noop) as Logger,
  );
}

export async function reconcileReproductionOutbox(
  db: Database,
  publisher: ReproductionPublisher,
  options: {
    batchSize: number;
    staleAfterMs: number;
    logger: Logger;
  },
): Promise<ReproductionReconciliationSummary> {
  const staleBefore = new Date(Date.now() - options.staleAfterMs);
  const stale = await listStaleReproductionOutbox(
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
    return claimStaleReproductionOutboxBatch(
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

  const result = await publishClaimedReproductionItems(
    db,
    claimed,
    publisher,
    options.logger,
  );

  options.logger.warn(
    {
      reproductionOutboxStalePending: stale.length,
      reproductionOutboxDispatched: result.dispatched,
      reproductionOutboxDeduplicated: result.deduplicated,
      reproductionOutboxFailed: result.failed,
    },
    "reproduction outbox reconciliation retried stale rows",
  );

  return { ...result, stalePending: stale.length };
}

export interface ReproductionDispatcherDeps {
  db: Database;
  publisher: ReproductionPublisher;
  logger: Logger;
  batchSize: number;
  pollMs: number;
}

export interface ReproductionDispatcherHandle {
  /** Runs exactly one bounded dispatch pass (used by tests and diagnostics). */
  runOnce(): Promise<ReproductionDispatchResult>;
  /** Stops scheduling and waits for any in-flight pass. */
  stop(): Promise<void>;
}

/** Upper bound on consecutive full-batch drains in one timer tick. */
const MAX_DRAIN_ITERATIONS = 10;

/**
 * Starts the reproduction dispatcher loop. Passes never overlap: the next
 * tick is scheduled only after the current one settles, and a full batch
 * triggers a bounded immediate drain instead of a hot loop.
 */
export function startReproductionDispatcher(
  deps: ReproductionDispatcherDeps,
): ReproductionDispatcherHandle {
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
        let summary: ReproductionDispatchResult;
        do {
          summary = await dispatchReproductionOutboxBatch(
            deps.db,
            deps.publisher,
            deps.batchSize,
            deps.logger,
          );
          if (summary.claimed > 0) {
            deps.logger.info(
              {
                reproductionOutboxClaimed: summary.claimed,
                reproductionOutboxDispatched: summary.dispatched,
                reproductionOutboxDeduplicated: summary.deduplicated,
                reproductionOutboxFailed: summary.failed,
              },
              "reproduction outbox batch dispatched",
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
          "reproduction outbox dispatcher pass failed; next pass will retry",
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
    runOnce(): Promise<ReproductionDispatchResult> {
      return dispatchReproductionOutboxBatch(
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

export interface ReproductionReconciliationDeps {
  db: Database;
  publisher: ReproductionPublisher;
  logger: Logger;
  batchSize: number;
  intervalMs: number;
  staleAfterMs: number;
}

export interface ReproductionReconciliationHandle {
  runOnce(): Promise<ReproductionReconciliationSummary>;
  stop(): Promise<void>;
}

export function startReproductionReconciliation(
  deps: ReproductionReconciliationDeps,
): ReproductionReconciliationHandle {
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
        await reconcileReproductionOutbox(deps.db, deps.publisher, {
          batchSize: deps.batchSize,
          staleAfterMs: deps.staleAfterMs,
          logger: deps.logger,
        });
      } catch (error) {
        deps.logger.error(
          { err: error },
          "reproduction outbox reconciliation pass failed; next pass will retry",
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
    runOnce(): Promise<ReproductionReconciliationSummary> {
      return reconcileReproductionOutbox(deps.db, deps.publisher, {
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
