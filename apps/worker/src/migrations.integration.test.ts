import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "@replaybug/db";
import { processEvent } from "./processors/process-event.js";
import { testDatabaseUrl } from "./test-helpers.js";

/**
 * Requirement: a pending event accepted before Block 5 (Block 4 database with
 * real telemetry) must remain intact across the migration and still be
 * processable by the new worker.
 *
 * This test builds a temporary Block 4 database, seeds telemetry through raw
 * SQL, applies the Block 5 migration and runs the real processor against it.
 */

const DRIZZLE_DIR = fileURLToPath(
  new URL("../../../packages/db/drizzle", import.meta.url),
);
const ADMIN_URL = testDatabaseUrl();

const createdDatabases: string[] = [];
const tempFolders: string[] = [];

function tempDatabaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createTempDatabase(): Promise<string> {
  const name = `replaybug_worker_mig_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  createdDatabases.push(name);
  return name;
}

async function buildPartialMigrationsFolder(maxIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "replaybug-worker-mig-"));
  tempFolders.push(folder);
  await mkdir(join(folder, "meta"), { recursive: true });

  const journalRaw = await readFile(
    join(DRIZZLE_DIR, "meta", "_journal.json"),
    "utf8",
  );
  const journal = JSON.parse(journalRaw) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
    "utf8",
  );
  for (const entry of entries) {
    const sql = await readFile(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    await writeFile(join(folder, `${entry.tag}.sql`), sql, "utf8");
  }
  return folder;
}

afterAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
  for (const folder of tempFolders) {
    await rm(folder, { recursive: true, force: true });
  }
});

describe("Block 4 → Block 5 migration with pending telemetry", () => {
  it("processes a pre-migration pending event with the new worker", async () => {
    const name = await createTempDatabase();
    const databaseUrl = tempDatabaseUrl(name);

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const db = drizzle(pool, { schema });
    try {
      // 1. Block 4 schema.
      const block4Folder = await buildPartialMigrationsFolder(1);
      await migrate(db, { migrationsFolder: block4Folder });

      const sessionId = "77777777-7777-4777-8777-777777777777";
      const eventId = "88888888-8888-4888-8888-888888888888";

      // 2. Telemetry accepted before the migration.
      await pool.query(
        `INSERT INTO "user" ("id", "name", "email")
           VALUES ('pre-mig-user', 'Pre Mig', 'premig@example.com')`,
      );
      await pool.query(
        `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
           VALUES ('99999999-9999-4999-8999-999999999999', 'PreMig WS', 'premig-ws', 'pre-mig-user')`,
      );
      await pool.query(
        `INSERT INTO projects ("id", "workspace_id", "name", "slug")
           VALUES ('aaaaaaaa-0000-4000-8000-000000000001',
                   '99999999-9999-4999-8999-999999999999', 'PreMig Proj', 'premig-proj')`,
      );
      await pool.query(
        `INSERT INTO telemetry_sessions
             ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
           VALUES ($1, 'aaaaaaaa-0000-4000-8000-000000000001', 'premig-session',
                   'production', 'https://example.com/', 'test-sdk@0.0.0')`,
        [sessionId],
      );
      await pool.query(
        `INSERT INTO events
             ("id", "project_id", "telemetry_session_id", "client_event_id",
              "sequence_number", "event_type", "occurred_at", "environment",
              "release", "payload_json", "processing_state")
           VALUES ($1, 'aaaaaaaa-0000-4000-8000-000000000001', $2, 'premig-client-event',
                   1, 'exception', now(), 'production', 'demo@0.9.0',
                   '{"values":[{"type":"TypeError","value":"Cannot load user 7192381","stacktrace":{"frames":[{"filename":"https://app.example.com/assets/index-Bx3K9mPQ.js","function":"loadUser","lineno":42,"in_app":true}]}}]}'::jsonb,
                   'pending')`,
        [eventId, sessionId],
      );
      await pool.query(
        `INSERT INTO event_processing_outbox ("event_id", "attempt_count")
           VALUES ($1, 0)`,
        [eventId],
      );

      // 3. Apply Block 5.
      await migrate(db, { migrationsFolder: DRIZZLE_DIR });

      // 4. The new worker processes the pre-migration event.
      const outcome = await processEvent({ db }, eventId);
      expect(outcome.status).toBe("processed");
      if (outcome.status !== "processed") throw new Error("unreachable");
      expect(outcome.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const issue = await pool.query(
        `SELECT status, occurrence_count, affected_session_count, first_release, title
           FROM issues WHERE id = $1`,
        [outcome.issueId],
      );
      expect(issue.rows[0]).toMatchObject({
        status: "open",
        occurrence_count: 1,
        affected_session_count: 1,
        first_release: "demo@0.9.0",
      });
      expect(String(issue.rows[0]?.title)).toContain("Cannot load user :id");

      const event = await pool.query(
        `SELECT processing_state, issue_id, fingerprint FROM events WHERE id = $1`,
        [eventId],
      );
      expect(event.rows[0]?.processing_state).toBe("processed");
      expect(event.rows[0]?.issue_id).toBe(outcome.issueId);
      expect(event.rows[0]?.fingerprint).toBe(outcome.fingerprint);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
