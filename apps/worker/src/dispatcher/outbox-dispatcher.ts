import type { Logger } from "@replaybug/observability";
import { claimPendingOutboxBatch } from "@replaybug/db";
import type { Database } from "@replaybug/db";
import {
  publishClaimedOutboxItems,
  type ProcessEventPublisher,
  type PublishBatchResult,
} from "./publish-batch.js";

/**
 * Transactional outbox dispatcher.
 *
 * A pass claims a bounded batch of undispatched rows with
 * `FOR UPDATE SKIP LOCKED` and, inside the same transaction, hands each row to
 * pg-boss and marks it dispatched. Rows are never marked before the publish is
 * durable. Concurrent dispatchers skip each other's locked rows.
 */
export interface OutboxDispatcherDeps {
  db: Database;
  publisher: ProcessEventPublisher;
  logger: Logger;
  batchSize: number;
  pollMs: number;
}

/** Upper bound on consecutive full-batch drains in one timer tick. */
const MAX_DRAIN_ITERATIONS = 10;

export async function dispatchOutboxBatch(
  deps: OutboxDispatcherDeps,
): Promise<PublishBatchResult> {
  return deps.db.transaction(async (tx) => {
    const items = await claimPendingOutboxBatch(tx, deps.batchSize);
    if (items.length === 0) {
      return { claimed: 0, dispatched: 0, deduplicated: 0, failed: 0 };
    }
    return publishClaimedOutboxItems(tx, items, {
      publisher: deps.publisher,
      logger: deps.logger,
    });
  });
}

export interface OutboxDispatcherHandle {
  /** Runs exactly one bounded dispatch pass (used by tests and diagnostics). */
  runOnce(): Promise<PublishBatchResult>;
  /** Stops scheduling and waits for any in-flight pass. */
  stop(): Promise<void>;
}

/**
 * Starts the dispatcher loop. Passes never overlap: the next tick is
 * scheduled only after the current one settles, and a full batch triggers a
 * bounded immediate drain instead of a hot loop.
 */
export function startOutboxDispatcher(
  deps: OutboxDispatcherDeps,
): OutboxDispatcherHandle {
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
        let summary: PublishBatchResult;
        do {
          summary = await dispatchOutboxBatch(deps);
          if (summary.claimed > 0) {
            deps.logger.info(
              {
                outboxClaimed: summary.claimed,
                outboxDispatched: summary.dispatched,
                outboxDeduplicated: summary.deduplicated,
                outboxFailed: summary.failed,
              },
              "outbox batch dispatched",
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
          "outbox dispatcher pass failed; next pass will retry",
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
    runOnce(): Promise<PublishBatchResult> {
      return dispatchOutboxBatch(deps);
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
