import { createLogger } from "@replaybug/observability";
import { checkDbHealth, createDbClient } from "@replaybug/db";
import { loadWorkerConfigFromEnv } from "./config.js";
import { listJobDefinitions, startJobs } from "./jobs/index.js";

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
    maxConnections: 5,
    connectionTimeoutMs: 5000,
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Worker shutting down");
    try {
      await client.close();
    } catch (error) {
      logger.error({ err: error }, "Error while closing database pool");
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const healthy = await checkDbHealth(client.pool, 5000);
    if (!healthy) {
      logger.error("PostgreSQL health check failed; worker cannot start");
      await client.close();
      process.exit(1);
    }

    await startJobs(logger);
    const jobs = listJobDefinitions();
    logger.info(
      { environment: config.environment, jobCount: jobs.length },
      "ReplayBug worker started",
    );
  } catch (error) {
    logger.error({ err: error }, "Worker failed to start");
    try {
      await client.close();
    } catch {
      // Shutdown path already logged; prefer the original startup error.
    }
    process.exit(1);
  }
}

void main();
