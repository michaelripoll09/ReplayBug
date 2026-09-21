import {
  runRetentionCleanupBatch,
  type Database,
  type RetentionCleanupBatchResult,
} from "@replaybug/db";
import type { Logger } from "@replaybug/observability";

export interface RunRetentionCleanupOptions {
  db: Database;
  batchSize: number;
  now?: Date;
}

export type RetentionCleanupResult = RetentionCleanupBatchResult;

/** Runs exactly one bounded retention transaction. */
export async function runRetentionCleanup(
  options: RunRetentionCleanupOptions,
): Promise<RetentionCleanupResult> {
  return runRetentionCleanupBatch(options.db, {
    batchSize: options.batchSize,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface RetentionCleanupRunnerDeps extends RunRetentionCleanupOptions {
  /** Delay between cleanup passes. The first pass starts immediately. */
  intervalMs: number;
  logger: Pick<Logger, "info" | "error">;
}

export interface RetentionCleanupRunner {
  /** Runs one bounded pass; concurrent calls share the in-flight pass. */
  runOnce(): Promise<RetentionCleanupResult>;
  /** Stops scheduling and waits for an in-flight pass to settle. */
  stop(): Promise<void>;
}

/**
 * Starts a supervised, non-overlapping retention runner.
 *
 * A transaction failure is intentionally not surfaced from the timer: the
 * transaction has rolled back, the next tick retries the same idempotent
 * selection, and logs contain only bounded counts and a generic failure code.
 */
export function startRetentionCleanupRunner(
  deps: RetentionCleanupRunnerDeps,
): RetentionCleanupRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<RetentionCleanupResult> | null = null;

  const runPass = (): Promise<RetentionCleanupResult> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const pass = runRetentionCleanup({
      db: deps.db,
      batchSize: deps.batchSize,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    inFlight = pass.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    if (inFlight !== null) {
      await inFlight.catch(() => undefined);
      scheduleNext(deps.intervalMs);
      return;
    }
    try {
      const result = await runPass();
      deps.logger.info(
        {
          retentionEventsDeleted: result.eventsDeleted,
          retentionSessionsDeleted: result.sessionsDeleted,
          retentionRateLimitBucketsDeleted: result.rateLimitBucketsDeleted,
        },
        "retention cleanup pass completed",
      );
    } catch {
      deps.logger.error(
        {
          retentionCleanupError: "transaction_failed",
          retentionCleanupBatchSize: deps.batchSize,
          retentionEventsDeleted: 0,
          retentionSessionsDeleted: 0,
          retentionRateLimitBucketsDeleted: 0,
        },
        "retention cleanup pass failed; next pass will retry",
      );
    }
    scheduleNext(deps.intervalMs);
  };

  scheduleNext(0);

  return {
    runOnce: runPass,
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight !== null) {
        await inFlight.catch(() => undefined);
      }
    },
  };
}
