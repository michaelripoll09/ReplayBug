/**
 * Dev-only seed: user + workspace + project + prod env + optional dev env + localhost origin.
 * Creates NO events/issues/sessions/releases.
 * DEMO/LOCAL ONLY credentials are documented below and must never be used in production.
 * Refuses to run when NODE_ENV=production.
 */
import { createDbClient, loadDbConfigFromEnv } from "@replaybug/db";
import { loadApiConfigFromEnv } from "../apps/api/src/config.js";
import { createAuth } from "../apps/api/src/auth.js";
import { createWorkspace } from "../apps/api/src/services/workspaces.js";
import {
  createEnvironment,
  createProject,
} from "../apps/api/src/services/projects.js";
import { addOrigin } from "../apps/api/src/services/origins.js";

const DEMO_EMAIL = "dev@replaybug.local";
const DEMO_PASSWORD = "ReplayBug!123";
const DEMO_NAME = "ReplayBug Dev";

async function main(): Promise<void> {
  if (
    process.env["NODE_ENV"] === "production" ||
    process.env["REPLAYBUG_ENVIRONMENT"] === "production"
  ) {
    console.error("Seed refuses to run in production (dev-only).");
    process.exit(1);
  }

  const dbConfig = loadDbConfigFromEnv(process.env);
  const apiConfig = loadApiConfigFromEnv({
    ...process.env,
    REPLAYBUG_DATABASE_URL: dbConfig.databaseUrl,
    REPLAYBUG_AUTH_SECRET:
      process.env["REPLAYBUG_AUTH_SECRET"] ??
      "local-dev-secret-0123456789abcdef0123456789",
  });
  const client = createDbClient({
    databaseUrl: dbConfig.databaseUrl,
    maxConnections: 5,
    connectionTimeoutMs: 5000,
  });
  try {
    const auth = createAuth(client.db, apiConfig);

    // Idempotent: reuse existing demo user when present.
    const existing = await client.pool.query(
      `SELECT id, email FROM "user" WHERE email = $1 LIMIT 1`,
      [DEMO_EMAIL],
    );
    let userId: string;
    if (existing.rows.length > 0) {
      userId = (existing.rows[0] as { id: string }).id;
      console.log(`Seed: reusing existing user ${DEMO_EMAIL}`);
    } else {
      const signed = (await auth.api.signUpEmail({
        body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
      })) as unknown as { user?: { id?: string } };
      const createdId = signed?.user?.id;
      if (typeof createdId !== "string" || createdId.length === 0) {
        // Fallback: read back the user row.
        const reread = await client.pool.query(
          `SELECT id FROM "user" WHERE email = $1 LIMIT 1`,
          [DEMO_EMAIL],
        );
        userId = (reread.rows[0] as { id: string }).id;
      } else {
        userId = createdId;
      }
      console.log(
        `Seed: created user ${DEMO_EMAIL} (DEMO/LOCAL ONLY password: ${DEMO_PASSWORD})`,
      );
    }

    // Idempotent workspace.
    const wsRows = await client.pool.query(
      `SELECT id FROM workspaces WHERE slug = $1 LIMIT 1`,
      ["replaybug-demo"],
    );
    let workspaceId: string;
    if (wsRows.rows.length > 0) {
      workspaceId = (wsRows.rows[0] as { id: string }).id;
      console.log("Seed: reusing workspace replaybug-demo");
    } else {
      const ws = await createWorkspace(client.db, userId, {
        name: "ReplayBug Demo",
        slug: "replaybug-demo",
      });
      workspaceId = ws.id;
      console.log(`Seed: created workspace ${ws.slug}`);
    }

    // Idempotent project.
    const projRows = await client.pool.query(
      `SELECT id FROM projects WHERE workspace_id = $1 AND slug = $2 LIMIT 1`,
      [workspaceId, "storefront-web"],
    );
    if (projRows.rows.length > 0) {
      console.log("Seed: reusing project storefront-web");
    } else {
      const created = await createProject(client.db, userId, workspaceId, {
        name: "Storefront Web",
        slug: "storefront-web",
        description: "Local demo storefront (seed).",
        timezone: "UTC",
        retentionDays: 30,
      });
      console.log(
        `Seed: created project ${created.project.slug} with production env + initial public key`,
      );
      console.log(
        `Seed: key prefix ${created.bootstrap.prefix} (one-time plaintext shown once, LOCAL ONLY)`,
      );
      // Minimal one-time display for local dev; never log in production.
      console.log(
        `Seed: public key (store securely, never shown again): ${created.bootstrap.key}`,
      );
      console.log(
        `Seed: ingest endpoint /api/ingest/v1/batch (live, dev only)`,
      );
    }

    const projIdRows = await client.pool.query(
      `SELECT id FROM projects WHERE workspace_id = $1 AND slug = $2 LIMIT 1`,
      [workspaceId, "storefront-web"],
    );
    const projectId = (projIdRows.rows[0] as { id: string }).id;

    // Optional dev environment (idempotent).
    const devEnv = await client.pool.query(
      `SELECT id FROM project_environments WHERE project_id = $1 AND name = $2 LIMIT 1`,
      [projectId, "development"],
    );
    if (devEnv.rows.length === 0) {
      await createEnvironment(client.db, userId, projectId, {
        name: "development",
        baseUrl: "http://localhost:5173",
      });
      console.log(
        "Seed: created development environment (http://localhost:5173)",
      );
    }

    // Localhost origin (explicit dev only, idempotent).
    const originRows = await client.pool.query(
      `SELECT id FROM project_origins WHERE project_id = $1 AND origin = $2 LIMIT 1`,
      [projectId, "http://localhost:5173"],
    );
    if (originRows.rows.length === 0) {
      await addOrigin(client.db, userId, projectId, {
        origin: "http://localhost:5173",
      });
      console.log("Seed: registered origin http://localhost:5173 (dev only)");
    }

    console.log("Seed complete: NO events/issues/sessions/releases created.");
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
