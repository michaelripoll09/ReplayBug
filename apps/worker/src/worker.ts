import { PgBoss } from "pg-boss";
import type { Logger } from "@replaybug/observability";
import type { DbClient } from "@replaybug/db";
import type { WorkerConfig } from "./config.js";
import {
  PROCESS_EVENT_QUEUE,
  buildProcessEventJob,
  processEventQueueOptions,
  processEventSendOptions,
} from "./queues/process-event.js";
import { createProcessEventJobHandler } from "./processors/process-event-handler.js";
import { startOutboxDispatcher } from "./dispatcher/outbox-dispatcher.js";
import { startOutboxReconciliation } from "./reconciliation/outbox-reconciliation.js";
import type { ProcessEventPublisher } from "./dispatcher/publish-batch.js";

/**
 * Worker composition root: pg-boss, the process-event consumer and the two
 * outbox loops. Ordering on startup is deliberate — pg-boss schema/queues
 * first, then consumers, then dispatching — and on shutdown the reverse:
 * stop claiming work, wait for in-flight jobs, then close pg-boss.
 */

/** pg-boss publish adapter with a stable job identity per event. */
export function createPgBossPublisher(boss: PgBoss): ProcessEventPublisher {
  return {
    publishProcessEvent(eventId: string): Promise<string | null> {
      return boss.send(
        PROCESS_EVENT_QUEUE,
        buildProcessEventJob(eventId),
        processEventSendOptions(eventId),
      );
    },
  };
}

export interface WorkerRuntimeDeps {
  config: WorkerConfig;
  logger: Logger;
  client: DbClient;
  /**
   * Injected pg-boss instance. Tests provide one; production builds it from
   * config. When injected, `stop()` still stops it but never closes a
   * database pool the runtime does not own.
   */
  boss?: PgBoss;
}

export interface RunningWorker {
  readonly boss: PgBoss;
  /** Stops claiming work, drains in-flight jobs, stops pg-boss. Idempotent. */
  stop(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 15_000;

export async function startWorkerRuntime(
  deps: WorkerRuntimeDeps,
): Promise<RunningWorker> {
  const { config, logger, client } = deps;
  const ownsBoss = deps.boss === undefined;
  const boss =
    deps.boss ??
    new PgBoss({
      connectionString: config.databaseUrl,
      schema: config.bossSchema,
      max: Math.max(4, config.concurrency + 2),
      connectionTimeoutMillis: 10_000,
      application_name: "replaybug-worker",
    });

  await boss.start();
  await boss.createQueue(PROCESS_EVENT_QUEUE, processEventQueueOptions(config));

  const publisher = createPgBossPublisher(boss);
  const handler = createProcessEventJobHandler({ db: client.db, logger });
  await boss.work(
    PROCESS_EVENT_QUEUE,
    {
      localConcurrency: config.concurrency,
      batchSize: 1,
      pollingIntervalSeconds: config.jobPollMs / 1000,
    },
    handler,
  );

  const dispatcher = startOutboxDispatcher({
    db: client.db,
    publisher,
    logger,
    batchSize: config.outboxBatchSize,
    pollMs: config.outboxPollMs,
  });
  const reconciliation = startOutboxReconciliation({
    db: client.db,
    publisher,
    logger,
    batchSize: config.outboxBatchSize,
    intervalMs: config.outboxReconcileMs,
    staleAfterMs: Math.max(config.outboxReconcileMs, config.outboxPollMs * 5),
  });

  let stopped = false;
  return {
    boss,
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      logger.info("Worker stopping: no longer claiming new work");
      await dispatcher.stop();
      await reconciliation.stop();
      await boss.offWork(PROCESS_EVENT_QUEUE, { wait: true });
      await boss.stop({
        graceful: true,
        timeout: SHUTDOWN_TIMEOUT_MS,
        close: ownsBoss,
      });
      logger.info("Worker stopped cleanly");
    },
  };
}
