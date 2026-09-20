import {
  retireExpiredPendingInvitations,
  type Database,
  type InvitationRow,
} from "@replaybug/db";
import type { Logger } from "@replaybug/observability";

export interface RunExpiredInvitationCleanupOptions {
  db: Database;
  batchSize: number;
  now?: Date;
}

export interface ExpiredInvitationCleanupResult {
  /** Rows retired by this transaction; callers must not log their contents. */
  retired: InvitationRow[];
  count: number;
}

/**
 * Retire one bounded batch of expired pending invitations atomically.
 *
 * The repository locks the eligible rows and rechecks their pending/expired
 * state during the update. A retry after a committed pass therefore finds no
 * rows already retired, while a failed transaction leaves the batch pending.
 */
export async function runExpiredInvitationCleanup(
  options: RunExpiredInvitationCleanupOptions,
): Promise<ExpiredInvitationCleanupResult> {
  const now = options.now ?? new Date();
  const retired = await options.db.transaction((tx) =>
    retireExpiredPendingInvitations(tx, {
      limit: options.batchSize,
      now,
    }),
  );
  return { retired, count: retired.length };
}

export interface ExpiredInvitationCleanupRunnerDeps extends RunExpiredInvitationCleanupOptions {
  /** Delay between cleanup passes. The first pass starts immediately. */
  intervalMs: number;
  logger: Pick<Logger, "info" | "error">;
}

export interface ExpiredInvitationCleanupRunner {
  /** Runs one bounded pass; concurrent calls share the in-flight pass. */
  runOnce(): Promise<ExpiredInvitationCleanupResult>;
  /** Stops scheduling and waits for an in-flight pass to settle. */
  stop(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts a supervised, non-overlapping interval runner. It intentionally runs
 * one bounded batch per tick; broader draining and retry policy belong to
 * RET-04 rather than this invitation-only cleanup.
 */
export function startExpiredInvitationCleanupRunner(
  deps: ExpiredInvitationCleanupRunnerDeps,
): ExpiredInvitationCleanupRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ExpiredInvitationCleanupResult> | null = null;

  const runPass = (): Promise<ExpiredInvitationCleanupResult> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const pass = runExpiredInvitationCleanup({
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
    if (stopped || inFlight !== null) {
      return;
    }
    try {
      const result = await runPass();
      deps.logger.info(
        { expiredInvitationCleanupRetired: result.count },
        "expired invitation cleanup pass completed",
      );
    } catch (error) {
      deps.logger.error(
        { expiredInvitationCleanupError: errorMessage(error) },
        "expired invitation cleanup pass failed; next pass will retry",
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
