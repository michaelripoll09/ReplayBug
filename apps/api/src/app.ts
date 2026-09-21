import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createLogger } from "@replaybug/observability";
import {
  LocalArtifactStorage,
  type ArtifactStorage,
} from "@replaybug/artifacts";
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
import { registerAiAnalysisRoutes } from "./routes/ai-analyses.js";
import { registerAuthRoutes } from "./routes/auth-handler.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerWorkspaceGovernanceRoutes } from "./routes/workspace-governance.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerEnvironmentRoutes } from "./routes/environments.js";
import { registerOriginRoutes } from "./routes/origins.js";
import { registerKeyRoutes } from "./routes/keys.js";
import { registerSecretTokenRoutes } from "./routes/secret-tokens.js";
import { registerCliRoutes } from "./routes/cli.js";
import { registerDashboardReleaseRoutes } from "./routes/dashboard-releases.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerReproductionRoutes } from "./routes/reproductions.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { createProjectUpdatesBroker } from "./realtime/broker.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerDemo500Route } from "./routes/demo/500.js";
import { registerPublicDemoRoutes } from "./routes/public-demo.js";

export interface BuildAppOptions {
  config: ApiConfig;
  checkDatabase?: () => Promise<boolean>;
  dbClient?: DbClient;
  auth?: Auth;
  /**
   * RS-06 test seam: integration suites inject temp-dir or failing
   * storage doubles. Production builds the shared local storage
   * (explicit `artifactDir` or the `REPLAYBUG_ARTIFACT_DIR` contract).
   */
  artifactStorage?: ArtifactStorage;
}

export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { config } = options;
  const logger = createLogger({ service: "api", level: config.logLevel });

  const app: AppInstance = Fastify({
    loggerInstance: logger,
    // Invitation credentials are carried in an accept-route path. Disable
    // automatic request logs so the normal logger cannot emit that path.
    logController: new LogController({ disableRequestLogging: true }),
  });

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
      "Idempotency-Key",
    ],
    credentials: true,
    maxAge: 86400,
  });
  await app.register(cookie);

  // RS-06 multipart uploads: the per-file cap is enforced by busboy
  // BEFORE unbounded buffering (over-limit streams surface as
  // FST_REQ_FILE_TOO_LARGE, mapped to 413 ARTIFACT_TOO_LARGE by the CLI
  // routes). Single-file uploads: further files are rejected downstream.
  await app.register(multipart, {
    limits: {
      fileSize: config.artifactMaxFileBytes,
      files: 1,
      fields: 10,
      fieldSize: 8192,
      fieldNameSize: 256,
    },
  });

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
            name: "Invitations",
            description: "Authenticated workspace invitation lifecycle",
          },
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
          {
            name: "SecretTokens",
            description: "Secret project tokens for CLI automation",
          },
          {
            name: "CLI",
            description:
              "Project-scoped CLI automation with Bearer secret-token auth",
          },
          {
            name: "Releases",
            description:
              "Session-authenticated dashboard release reads with artifact metadata",
          },
          {
            name: "Issues",
            description: "Issue list/detail, lifecycle, tags, comments",
          },
          {
            name: "Reproductions",
            description: "Playwright reproduction generation + download",
          },
          {
            name: "Tags",
            description: "Project-local issue tags + assignments",
          },
          {
            name: "Comments",
            description: "Issue comments with author-only edit",
          },
          {
            name: "Metrics",
            description: "Diagnosis-focused project metrics",
          },
          {
            name: "Sessions",
            description: "Telemetry sessions, timelines and context",
          },
          {
            name: "Notifications",
            description: "Own-user in-app notifications",
          },
          {
            name: "Realtime",
            description:
              "Project-scoped Server-Sent Events invalidation stream",
          },
          {
            name: "Ingest",
            description: "Public telemetry event ingestion",
          },
          {
            name: "AI Analysis",
            description: "Optional local Ollama issue analysis",
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "opaque",
              description:
                "CLI secret project token (rb_sk_…). Send as Authorization: Bearer <token>. Never send credentials in query strings.",
            },
          },
        },
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

  // Health is registered after the artifact store resolves so the ready
  // probe can report storage status (informational only — storage never
  // flips readiness; see registerHealthRoutes).
  const artifactStorage =
    options.artifactStorage ??
    (config.artifactDir !== undefined
      ? new LocalArtifactStorage({ root: config.artifactDir })
      : LocalArtifactStorage.fromEnv());
  await registerHealthRoutes(app, {
    checkDatabase,
    checkArtifactStorage: async (): Promise<boolean> => {
      try {
        // Sentinel key that never exists: `false` proves the store answers,
        // a throw proves it is down. Read-only, never writes, never lists.
        await artifactStorage.exists("replaybug-health-probe");
        return true;
      } catch {
        return false;
      }
    },
  });
  await registerMetaRoutes(app, {
    version: config.version,
    environment: config.environment,
    auth,
    config,
  });
  await registerAuthRoutes(app, auth);
  await registerMeRoutes(app, { auth });
  await registerWorkspaceRoutes(app, { db, auth });
  await registerInvitationRoutes(app, {
    db,
    auth,
    webUrl: config.webUrl,
  });
  await registerWorkspaceGovernanceRoutes(app, { db, auth });
  await registerProjectRoutes(app, { db, auth });
  await registerEnvironmentRoutes(app, { db, auth });
  await registerOriginRoutes(app, { db, auth });
  await registerKeyRoutes(app, { db, auth });
  await registerSecretTokenRoutes(app, { db, auth });
  await registerCliRoutes(app, {
    db,
    artifacts: {
      storage: artifactStorage,
      maxFileBytes: config.artifactMaxFileBytes,
      preflightMaxEntries: config.artifactPreflightMaxEntries,
      aggregateMaxBytes: config.artifactAggregateMaxBytes,
      stagingDir: config.artifactStagingDir,
    },
  });
  await registerIssueRoutes(app, { db, auth });
  await registerReproductionRoutes(app, { db, auth });
  await registerDashboardReleaseRoutes(app, { db, auth });
  await registerNotificationRoutes(app, { db, auth });

  // Process-level LISTEN broker (one connection per API process) feeding
  // the SSE route. Lazy: connects on the first stream subscriber.
  const broker = createProjectUpdatesBroker({
    connectionString: config.databaseUrl,
    logger: {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    },
  });
  app.addHook("onClose", async () => {
    await broker.stop();
  });
  await registerRealtimeRoutes(app, {
    db,
    auth,
    broker,
    trustedOrigins: config.trustedOrigins,
  });
  await registerSessionRoutes(app, { db, auth });
  await registerIngestRoutes(app, { db, config });
  await registerAiAnalysisRoutes(app, { db, dbClient, auth, config });
  await registerPublicDemoRoutes(app, { db, config });
  await registerDemo500Route(app);

  return app;
}
