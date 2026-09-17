import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createLogger } from "@replaybug/observability";
import {
  checkDbHealth,
  createDbClient,
  type Database,
  type DbClient,
} from "@replaybug/db";
import { type ApiConfig } from "./config.js";
import { type AppInstance } from "./instance.js";
import { createAuth, type Auth } from "./auth.js";
import { registerRequestId } from "./plugins/request-id.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerAuthRoutes } from "./routes/auth-handler.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerOriginRoutes } from "./routes/origins.js";
import { registerKeyRoutes } from "./routes/keys.js";

export interface BuildAppOptions {
  config: ApiConfig;
  checkDatabase?: () => Promise<boolean>;
  dbClient?: DbClient;
  auth?: Auth;
}

export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { config } = options;
  const logger = createLogger({ service: "api", level: config.logLevel });

  const app: AppInstance = Fastify({ loggerInstance: logger });

  await registerRequestId(app);
  await registerErrorHandler(app);

  // Strict dashboard CORS with credentials. Never "*" when credentials are on.
  await app.register(cors, {
    origin: config.trustedOrigins,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "x-request-id",
    ],
    credentials: true,
    maxAge: 86400,
  });
  await app.register(cookie);

  // Interactive OpenAPI docs in non-production only.
  if (config.nodeEnv !== "production") {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "ReplayBug API",
          version: config.version,
        },
        tags: [
          {
            name: "Auth",
            description: "Better Auth session endpoints + current user",
          },
          { name: "Workspaces", description: "Tenant workspaces" },
          {
            name: "Projects",
            description: "Workspace projects + bootstrap keys",
          },
          {
            name: "Environments",
            description: "Project environments and base URLs",
          },
          { name: "Origins", description: "Project browser-origin allowlist" },
          {
            name: "Keys",
            description: "Public ingest key metadata + rotation",
          },
        ],
      },
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs",
    });
  }

  const ownedClient = options.dbClient ?? null;
  const dbClient: DbClient =
    ownedClient ??
    createDbClient({
      databaseUrl: config.databaseUrl,
      maxConnections: 10,
      connectionTimeoutMs: 5000,
    });
  const db: Database = dbClient.db;
  const auth: Auth = options.auth ?? createAuth(db, config);

  // Close owned pools on shutdown. Injected test clients are closed by the test.
  if (ownedClient === null) {
    app.addHook("onClose", async () => {
      await dbClient.close();
    });
  }

  const checkDatabase =
    options.checkDatabase ??
    (async (): Promise<boolean> => {
      try {
        return await checkDbHealth(dbClient.pool, 2000);
      } catch {
        return false;
      }
    });

  await registerHealthRoutes(app, { checkDatabase });
  await registerMetaRoutes(app, {
    version: config.version,
    environment: config.environment,
  });
  await registerAuthRoutes(app, auth);
  await registerMeRoutes(app, { auth });
  await registerWorkspaceRoutes(app, { db, auth });
  await registerProjectRoutes(app, { db, auth });
  await registerEnvironmentRoutes(app, { db, auth });
  await registerOriginRoutes(app, { db, auth });
  await registerKeyRoutes(app, { db, auth });

  return app;
}
