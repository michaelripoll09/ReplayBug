import { createLogger } from "@replaybug/observability";
import { checkDbHealth, createDbClient } from "@replaybug/db";
import { loadWorkerConfigFromEnv } from "./config.js";
import { listRegisteredJobContracts } from "./queues/index.js";
import { startWorkerRuntime, type RunningWorker } from "./worker.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadWorkerConfigFromEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const logger = createLogger({ service: "worker", level: config.logLevel });
  const client = createDbClient({
    databaseUrl: config.databaseUrl,
    // pg-boss runs its own pool; this one serves the processor and outbox
    // queries. Concurrency plus outbox passes need a handful of connections.
    maxConnections: Math.max(5, config.concurrency + 3),
    connectionTimeoutMs: 5000,
  });

  let running: RunningWorker | null = null;
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Worker shutting down");
    try {
      await running?.stop();
    } catch (error) {
      logger.error({ err: error }, "Error while stopping worker runtime");
    }
    try {
      await client.close();
    } catch (error) {
      logger.error({ err: error }, "Error while closing database pool");
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled rejection; exiting non-zero");
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "Uncaught exception; exiting non-zero");
    process.exit(1);
  });

  try {
    const healthy = await checkDbHealth(client.pool, 5000);
    if (!healthy) {
      logger.error("PostgreSQL health check failed; worker cannot start");
      await client.close();
      process.exit(1);
    }

    running = await startWorkerRuntime({ config, logger, client });
    logger.info(
      {
        environment: config.environment,
        queues: listRegisteredJobContracts().map((contract) => contract.name),
        concurrency: config.concurrency,
        outboxBatchSize: config.outboxBatchSize,
      },
      "ReplayBug worker started",
    );
  } catch (error) {
    logger.error({ err: error }, "Worker failed to start");
    try {
      await running?.stop();
    } catch {
      // The startup error is the useful one here.
    }
    try {
      await client.close();
    } catch {
      // Shutdown path already logged; prefer the original startup error.
    }
    process.exit(1);
  }
}

void main();
