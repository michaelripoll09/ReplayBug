import type { Logger } from "@replaybug/observability";
import {
  markOutboxDispatched,
  recordOutboxDispatchFailure,
} from "@replaybug/db";
import type { DbTransaction, PendingOutboxItem } from "@replaybug/db";

/**
 * Publishes claimed outbox rows to pg-boss and records the outcome.
 *
 * Contract with pg-boss: `send()` returns a job id on insert, or null when the
 * insert was skipped by the (name, id) primary key — i.e. a durable job with
 * that stable id already exists. Both outcomes mean "durably handed off", so
 * both mark the row dispatched. A thrown error means the handoff did not
 * happen: the row stays pending, `attempt_count` increments and a sanitized
 * `last_error` is stored for inspection.
 */
export interface ProcessEventPublisher {
  publishProcessEvent(eventId: string): Promise<string | null>;
}

export interface PublishBatchResult {
  claimed: number;
  dispatched: number;
  deduplicated: number;
  failed: number;
}

export interface PublishBatchDeps {
  publisher: ProcessEventPublisher;
  logger: Logger;
}

/**
 * Bounds a stored failure message so the outbox never accumulates unbounded
 * or payload-bearing error text.
 */
export function sanitizeOutboxError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function publishClaimedOutboxItems(
  tx: DbTransaction,
  items: readonly PendingOutboxItem[],
  deps: PublishBatchDeps,
): Promise<PublishBatchResult> {
  let dispatched = 0;
  let deduplicated = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const jobId = await deps.publisher.publishProcessEvent(item.eventId);
      if (jobId === null) {
        deduplicated++;
      }
      await markOutboxDispatched(tx, item.eventId);
      dispatched++;
      deps.logger.debug(
        {
          outboxEventId: item.eventId,
          jobId,
          attempt: item.attemptCount,
          result: jobId === null ? "deduplicated" : "published",
        },
        "outbox row dispatched",
      );
    } catch (error) {
      failed++;
      const sanitized = sanitizeOutboxError(error);
      await recordOutboxDispatchFailure(tx, item.eventId, sanitized);
      deps.logger.warn(
        {
          outboxEventId: item.eventId,
          attempt: item.attemptCount + 1,
          result: "publish-failed",
          error: sanitized,
        },
        "outbox publish failed; row remains pending for retry",
      );
    }
  }

  return { claimed: items.length, dispatched, deduplicated, failed };
}
