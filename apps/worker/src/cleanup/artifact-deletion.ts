import {
  ArtifactDeletionRepo,
  type Database,
  type PendingArtifactDeletionItem,
} from "@replaybug/db";
import {
  parseArtifactStorageKey,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import type { Logger } from "@replaybug/observability";

export interface ArtifactDeletionBatchResult {
  claimed: number;
  completed: number;
  failed: number;
}

export interface RunArtifactDeletionOptions {
  db: Database;
  storage: ArtifactStorage;
  batchSize: number;
}

function validateItem(item: PendingArtifactDeletionItem): void {
  const parsed = parseArtifactStorageKey(item.storageKey);
  if (item.projectId !== null && item.projectId !== parsed.projectId) {
    throw new Error("artifact project prefix mismatch");
  }
}

function failureCode(item: PendingArtifactDeletionItem): string {
  try {
    validateItem(item);
    return "storage_unavailable";
  } catch {
    return "invalid_storage_key";
  }
}

/**
 * Processes one bounded outbox transaction. The row locks remain held while
 * the filesystem operation runs, so concurrent workers skip the same rows.
 * If the process dies after the filesystem delete and before the DB update,
 * the next run treats the missing file as successful and completes the row.
 */
export async function runArtifactDeletionBatch(
  options: RunArtifactDeletionOptions,
): Promise<ArtifactDeletionBatchResult> {
  return options.db.transaction(async (tx) => {
    const items = await ArtifactDeletionRepo.claimPendingArtifactDeletionBatch(
      tx,
      options.batchSize,
    );
    let completed = 0;
    let failed = 0;
    for (const item of items) {
      try {
        validateItem(item);
        await options.storage.delete(item.storageKey);
        const row = await ArtifactDeletionRepo.markArtifactDeletionCompleted(
          tx,
          item.id,
        );
        if (row !== undefined) {
          completed += 1;
        }
      } catch {
        await ArtifactDeletionRepo.recordArtifactDeletionFailure(
          tx,
          item.id,
          failureCode(item),
        );
        failed += 1;
      }
    }
    return { claimed: items.length, completed, failed };
  });
}

export interface ArtifactDeletionRunnerDeps extends RunArtifactDeletionOptions {
  intervalMs: number;
  logger: Pick<Logger, "info" | "error">;
}

export interface ArtifactDeletionRunner {
  runOnce(): Promise<ArtifactDeletionBatchResult>;
  stop(): Promise<void>;
}

/** Starts a non-overlapping, bounded artifact deletion cleanup loop. */
export function startArtifactDeletionRunner(
  deps: ArtifactDeletionRunnerDeps,
): ArtifactDeletionRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ArtifactDeletionBatchResult> | null = null;

  const runPass = (): Promise<ArtifactDeletionBatchResult> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const pass = runArtifactDeletionBatch({
      db: deps.db,
      storage: deps.storage,
      batchSize: deps.batchSize,
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
      if (result.claimed > 0) {
        deps.logger.info(
          {
            artifactDeletionClaimed: result.claimed,
            artifactDeletionCompleted: result.completed,
            artifactDeletionFailed: result.failed,
          },
          "artifact deletion pass completed",
        );
      }
    } catch {
      deps.logger.error(
        {
          artifactDeletionError: "transaction_failed",
          artifactDeletionBatchSize: deps.batchSize,
        },
        "artifact deletion pass failed; next pass will retry",
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
