import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createLogger } from "@replaybug/observability";
import { checkDbHealth, createDbClient } from "@replaybug/db";
import { type ApiConfig } from "./config.js";
import { type AppInstance } from "./instance.js";
import { registerRequestId } from "./plugins/request-id.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaRoutes } from "./routes/meta.js";

export interface BuildAppOptions {
  config: ApiConfig;
  checkDatabase?: () => Promise<boolean>;
}

export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { config } = options;
  const logger = createLogger({ service: "api", level: config.logLevel });

  const app: AppInstance = Fastify({ loggerInstance: logger });

  await registerRequestId(app);
  await registerErrorHandler(app);

  // Interactive OpenAPI docs in non-production only.
  if (config.nodeEnv !== "production") {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "ReplayBug API",
          version: config.version,
        },
      },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });
  }

  const checkDatabase =
    options.checkDatabase ??
    (async (): Promise<boolean> => {
      const client = createDbClient({
        databaseUrl: config.databaseUrl,
        maxConnections: 2,
        connectionTimeoutMs: 2000,
      });
      try {
        return await checkDbHealth(client.pool, 2000);
      } finally {
        await client.close();
      }
    });

  await registerHealthRoutes(app, { checkDatabase });
  await registerMetaRoutes(app, {
    version: config.version,
    environment: config.environment,
  });

  return app;
}
