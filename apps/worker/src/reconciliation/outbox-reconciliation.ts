import type { Logger } from "@replaybug/observability";
import { claimStaleOutboxBatch, listStaleOutbox } from "@replaybug/db";
import type { Database } from "@replaybug/db";
import {
  publishClaimedOutboxItems,
  type ProcessEventPublisher,
  type PublishBatchResult,
} from "../dispatcher/publish-batch.js";

/**
 * Outbox reconciliation.
 *
 * The dispatcher already retries every undispatched row on each pass; the
 * reconciliation loop targets rows that have stayed pending longer than a
 * threshold (a sign of repeated publish failures or a stalled dispatcher),
 * retries them in a bounded locked batch and reports the result. It is
 * timer-driven, non-overlapping and stoppable — never a hot loop.
 */
export interface OutboxReconciliationDeps {
  db: Database;
  publisher: ProcessEventPublisher;
  logger: Logger;
  batchSize: number;
  intervalMs: number;
  staleAfterMs: number;
}

export interface OutboxReconciliationSummary extends PublishBatchResult {
  stalePending: number;
}

export async function reconcileOutbox(
  deps: OutboxReconciliationDeps,
): Promise<OutboxReconciliationSummary> {
  const staleBefore = new Date(Date.now() - deps.staleAfterMs);
  const stale = await listStaleOutbox(deps.db, staleBefore, deps.batchSize);
  if (stale.length === 0) {
    return {
      claimed: 0,
      dispatched: 0,
      deduplicated: 0,
      failed: 0,
      stalePending: 0,
    };
  }

  const result = await deps.db.transaction(async (tx) => {
    const items = await claimStaleOutboxBatch(tx, staleBefore, deps.batchSize);
    if (items.length === 0) {
      return { claimed: 0, dispatched: 0, deduplicated: 0, failed: 0 };
    }
    return publishClaimedOutboxItems(tx, items, {
      publisher: deps.publisher,
      logger: deps.logger,
    });
  });

  deps.logger.warn(
    {
      outboxStalePending: stale.length,
      outboxDispatched: result.dispatched,
      outboxDeduplicated: result.deduplicated,
      outboxFailed: result.failed,
    },
    "outbox reconciliation retried stale rows",
  );

  return { ...result, stalePending: stale.length };
}

export interface OutboxReconciliationHandle {
  runOnce(): Promise<OutboxReconciliationSummary>;
  stop(): Promise<void>;
}

export function startOutboxReconciliation(
  deps: OutboxReconciliationDeps,
): OutboxReconciliationHandle {
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
        await reconcileOutbox(deps);
      } catch (error) {
        deps.logger.error(
          { err: error },
          "outbox reconciliation pass failed; next pass will retry",
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
    runOnce(): Promise<OutboxReconciliationSummary> {
      return reconcileOutbox(deps);
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
