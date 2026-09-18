/**
 * Block 4 E2E fixture seed.
 *
 * Runs BEFORE Playwright starts (see package.json test:e2e). It resets the
 * E2E database, creates a real user + workspace + project, generates a real
 * public ingest key, configures the exact demo origin and writes the
 * per-run DSN to `.e2e/dsn.json` (gitignored, never logged).
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePublicKey, hashPublicKey } from "@replaybug/db";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", ".e2e");
const OUT_FILE = join(OUT_DIR, "dsn.json");

const DATABASE_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
const API_URL = process.env["REPLAYBUG_API_URL"] ?? "http://localhost:4001";
const DEMO_ORIGIN = "http://localhost:5173";

const USER_ID = "e2e-fixture-user";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await pool.query(`
      TRUNCATE "user", "session", "account", "verification",
        "audit_logs", "event_processing_outbox", "events",
        "rate_limit_buckets", "telemetry_sessions",
        "project_keys", "project_origins", "project_environments",
        "projects", "workspace_memberships", "workspaces"
      RESTART IDENTITY CASCADE
    `);

    await pool.query(
      `INSERT INTO "user" ("id", "name", "email")
       VALUES ($1, 'E2E Fixture User', $2)`,
      [USER_ID, `e2e-${randomUUID().slice(0, 8)}@example.com`],
    );
    await pool.query(
      `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
       VALUES ($1, 'E2E WS', 'e2e-ws', $2)`,
      [WORKSPACE_ID, USER_ID],
    );
    await pool.query(
      `INSERT INTO workspace_memberships ("workspace_id", "user_id", "role")
       VALUES ($1, $2, 'owner')`,
      [WORKSPACE_ID, USER_ID],
    );
    await pool.query(
      `INSERT INTO projects ("id", "workspace_id", "name", "slug")
       VALUES ($1, $2, 'E2E Proj', 'e2e-proj')`,
      [PROJECT_ID, WORKSPACE_ID],
    );

    const { fullKey, prefix } = generatePublicKey();
    const keyHash = hashPublicKey(fullKey);
    await pool.query(
      `INSERT INTO project_keys ("project_id", "kind", "name", "prefix", "key_hash")
       VALUES ($1, 'public_ingest', 'e2e key', $2, $3)`,
      [PROJECT_ID, prefix, keyHash],
    );
    await pool.query(
      `INSERT INTO project_origins ("project_id", "origin")
       VALUES ($1, $2)`,
      [PROJECT_ID, DEMO_ORIGIN],
    );

    const apiUrl = new URL(API_URL);
    const dsn = `${apiUrl.protocol}//${fullKey}@${apiUrl.host}/api/ingest/v1`;

    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      OUT_FILE,
      JSON.stringify(
        { dsn, projectId: PROJECT_ID, origin: DEMO_ORIGIN },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      "E2E fixture ready: project + key + origin seeded (.e2e/dsn.json written).",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("E2E seed failed:", error);
  process.exit(1);
});
