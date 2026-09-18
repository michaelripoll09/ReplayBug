import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "./schema.js";
import { claimPendingOutboxBatch } from "./repositories/outbox.js";

/**
 * Forward-only migration tests against real PostgreSQL.
 *
 * A. Upgrade path from Block 3: temporary database at the Block 3 schema,
 *    real fixture rows, then all later migrations are applied and the fixture
 *    must survive while the telemetry and issue tables appear.
 * B. Empty database: full migration run from 0000 to latest, expected schema
 *    checks, and a second migrate run must be a clean no-op.
 * C. Block 4 → Block 5 with existing telemetry: sessions, pending events and
 *    undispatched outbox rows survive the migration and stay claimable by the
 *    dispatcher.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "drizzle");

const ADMIN_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

const TELEMETRY_TABLES = [
  "telemetry_sessions",
  "events",
  "event_processing_outbox",
  "rate_limit_buckets",
];

const ISSUE_TABLES = [
  "issues",
  "issue_activity",
  "issue_affected_sessions",
  "notifications",
];

const createdDatabases: string[] = [];
const tempFolders: string[] = [];

function tempDatabaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createTempDatabase(): Promise<string> {
  const name = `replaybug_mig_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  createdDatabases.push(name);
  return name;
}

async function withPool<T>(
  databaseUrl: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function runMigrations(
  databaseUrl: string,
  folder: string,
): Promise<void> {
  await withPool(databaseUrl, async (pool) => {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: folder });
  });
}

/** Builds a migrations folder that only contains entries up to maxIdx. */
async function buildPartialMigrationsFolder(maxIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "replaybug-mig-"));
  tempFolders.push(folder);
  await mkdir(join(folder, "meta"), { recursive: true });

  const journalRaw = await readFile(
    join(MIGRATIONS_DIR, "meta", "_journal.json"),
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
    const sql = await readFile(
      join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      "utf8",
    );
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

describe("migrations against real PostgreSQL", () => {
  it("upgrades a Block 3 database to latest preserving existing data", async () => {
    const name = await createTempDatabase();
    const databaseUrl = tempDatabaseUrl(name);

    // 1. Bring the temporary database to the Block 3 schema state (0000 only).
    const partialFolder = await buildPartialMigrationsFolder(0);
    await runMigrations(databaseUrl, partialFolder);

    await withPool(databaseUrl, async (pool) => {
      const preBlock4 = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'events'`,
      );
      expect(preBlock4.rows.length).toBe(0);

      // 2. Insert a valid Block 3 fixture through SQL.
      await pool.query(
        `INSERT INTO "user" ("id", "name", "email")
         VALUES ('fixture-user-1', 'Fixture User', 'fixture@example.com')`,
      );
      await pool.query(
        `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
         VALUES ('11111111-1111-4111-8111-111111111111', 'Fixture WS', 'fixture-ws', 'fixture-user-1')`,
      );
      await pool.query(
        `INSERT INTO workspace_memberships ("workspace_id", "user_id", "role")
         VALUES ('11111111-1111-4111-8111-111111111111', 'fixture-user-1', 'owner')`,
      );
      await pool.query(
        `INSERT INTO projects ("id", "workspace_id", "name", "slug")
         VALUES ('22222222-2222-4222-8222-222222222222',
                 '11111111-1111-4111-8111-111111111111',
                 'Fixture Proj', 'fixture-proj')`,
      );
    });

    // 3. Apply the Block 4 migration (the real migrator skips 0000 because its
    //    hash is already recorded and applies 0001).
    await runMigrations(databaseUrl, MIGRATIONS_DIR);

    await withPool(databaseUrl, async (pool) => {
      // 4. Old fixture preserved.
      const user = await pool.query(
        `SELECT name FROM "user" WHERE id = 'fixture-user-1'`,
      );
      expect(user.rows[0]?.name).toBe("Fixture User");
      const project = await pool.query(
        `SELECT name FROM projects WHERE id = '22222222-2222-4222-8222-222222222222'`,
      );
      expect(project.rows[0]?.name).toBe("Fixture Proj");
      const membership = await pool.query(
        `SELECT role FROM workspace_memberships
         WHERE workspace_id = '11111111-1111-4111-8111-111111111111'`,
      );
      expect(membership.rows[0]?.role).toBe("owner");

      // 5. Telemetry and issue tables exist.
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...TELEMETRY_TABLES, ...ISSUE_TABLES]],
      );
      expect(
        tables.rows.map((r: { table_name: string }) => r.table_name).sort(),
      ).toEqual([...TELEMETRY_TABLES, ...ISSUE_TABLES].sort());
    });
  });

  it("migrates an empty database from 0000 to latest and re-runs cleanly", async () => {
    const name = await createTempDatabase();
    const databaseUrl = tempDatabaseUrl(name);

    // Full migration run.
    await runMigrations(databaseUrl, MIGRATIONS_DIR);

    const expectedTables = [
      "user",
      "session",
      "account",
      "verification",
      "workspaces",
      "workspace_memberships",
      "projects",
      "project_environments",
      "project_origins",
      "project_keys",
      "audit_logs",
      ...TELEMETRY_TABLES,
      ...ISSUE_TABLES,
    ];

    await withPool(databaseUrl, async (pool) => {
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [expectedTables],
      );
      expect(tables.rows.length).toBe(expectedTables.length);

      // Critical Block 4 structure: enum, unique idempotency constraint and
      // nullable anonymous hash column.
      const enumValues = await pool.query(
        `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'processing_state'
         ORDER BY enumsortorder`,
      );
      expect(
        enumValues.rows.map((r: { enumlabel: string }) => r.enumlabel),
      ).toEqual(["pending", "processed", "rejected"]);

      const unique = await pool.query(
        `SELECT conname FROM pg_constraint
         WHERE conname = 'events_project_client_event_unique'`,
      );
      expect(unique.rows.length).toBe(1);

      const hashColumn = await pool.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'telemetry_sessions' AND column_name = 'anonymous_user_hash'`,
      );
      expect(hashColumn.rows[0]?.is_nullable).toBe("YES");

      // Critical Block 5 structure: issue grouping key, event association
      // columns and outbox ordering column.
      const issueUnique = await pool.query(
        `SELECT conname FROM pg_constraint
         WHERE conname = 'issues_project_fingerprint_unique'`,
      );
      expect(issueUnique.rows.length).toBe(1);

      const eventColumns = await pool.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'events' AND column_name IN ('fingerprint','issue_id')
         ORDER BY column_name`,
      );
      expect(eventColumns.rows).toEqual([
        { column_name: "fingerprint", is_nullable: "YES" },
        { column_name: "issue_id", is_nullable: "YES" },
      ]);

      const outboxCreatedAt = await pool.query(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'event_processing_outbox' AND column_name = 'created_at'`,
      );
      expect(outboxCreatedAt.rows[0]?.is_nullable).toBe("NO");

      const issueIndexes = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname IN
           ('issues_project_status_last_seen_idx','issues_project_last_seen_idx',
            'events_issue_occurred_idx','issue_activity_issue_created_idx','notifications_user_read_created_idx')
         ORDER BY indexname`,
      );
      expect(
        issueIndexes.rows.map((r: { indexname: string }) => r.indexname),
      ).toEqual([
        "events_issue_occurred_idx",
        "issue_activity_issue_created_idx",
        "issues_project_last_seen_idx",
        "issues_project_status_last_seen_idx",
        "notifications_user_read_created_idx",
      ]);
    });

    // Second run: no pending migrations, no corruption.
    await runMigrations(databaseUrl, MIGRATIONS_DIR);

    await withPool(databaseUrl, async (pool) => {
      const tables = await pool.query(
        `SELECT COUNT(*)::int AS count FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [expectedTables],
      );
      expect(tables.rows[0]?.count).toBe(expectedTables.length);

      const journal = await pool.query(
        `SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );
      // One journal row per migration file (0000 + 0001 + 0002), never duplicated.
      expect(journal.rows[0]?.count).toBe(3);
    });
  });

  it("upgrades a Block 4 database with telemetry to Block 5 preserving data", async () => {
    const name = await createTempDatabase();
    const databaseUrl = tempDatabaseUrl(name);

    // 1. Block 4 schema (0000 + 0001).
    const block4Folder = await buildPartialMigrationsFolder(1);
    await runMigrations(databaseUrl, block4Folder);

    const sessionId = "33333333-3333-4333-8333-333333333333";
    const eventId = "44444444-4444-4444-8444-444444444444";

    // 2. Real Block 4 telemetry fixture: session + pending event + outbox row.
    await withPool(databaseUrl, async (pool) => {
      await pool.query(
        `INSERT INTO "user" ("id", "name", "email")
         VALUES ('fixture-user-5', 'Fixture User', 'fixture5@example.com')`,
      );
      await pool.query(
        `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
         VALUES ('55555555-5555-4555-8555-555555555555', 'Fixture WS', 'fixture-ws-5', 'fixture-user-5')`,
      );
      await pool.query(
        `INSERT INTO projects ("id", "workspace_id", "name", "slug")
         VALUES ('66666666-6666-4666-8666-666666666666',
                 '55555555-5555-4555-8555-555555555555',
                 'Fixture Proj', 'fixture-proj-5')`,
      );
      await pool.query(
        `INSERT INTO telemetry_sessions
           ("id", "project_id", "sdk_session_id", "environment", "initial_url", "sdk_version")
         VALUES ($1, '66666666-6666-4666-8666-666666666666', 'sdk-session-5',
                 'production', 'https://example.com/', 'test-sdk@0.0.0')`,
        [sessionId],
      );
      await pool.query(
        `INSERT INTO events
           ("id", "project_id", "telemetry_session_id", "client_event_id",
            "sequence_number", "event_type", "occurred_at", "environment",
            "release", "payload_json", "processing_state")
         VALUES ($1, '66666666-6666-4666-8666-666666666666', $2, 'client-event-5',
                 1, 'exception', now(), 'production', 'demo@1.0.0',
                 '{"values":[{"type":"TypeError","value":"pre-migration failure"}]}'::jsonb,
                 'pending')`,
        [eventId, sessionId],
      );
      await pool.query(
        `INSERT INTO event_processing_outbox ("event_id", "attempt_count")
         VALUES ($1, 0)`,
        [eventId],
      );
    });

    // 3. Apply Block 5.
    await runMigrations(databaseUrl, MIGRATIONS_DIR);

    // 4. Telemetry survives and pending work stays claimable.
    await withPool(databaseUrl, async (pool) => {
      const session = await pool.query(
        `SELECT project_id, sdk_session_id FROM telemetry_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(session.rows[0]?.sdk_session_id).toBe("sdk-session-5");

      const event = await pool.query(
        `SELECT processing_state, release, fingerprint, issue_id
         FROM events WHERE id = $1`,
        [eventId],
      );
      expect(event.rows[0]?.processing_state).toBe("pending");
      expect(event.rows[0]?.release).toBe("demo@1.0.0");
      expect(event.rows[0]?.fingerprint).toBeNull();
      expect(event.rows[0]?.issue_id).toBeNull();

      const outbox = await pool.query(
        `SELECT dispatched_at, attempt_count, created_at
         FROM event_processing_outbox WHERE event_id = $1`,
        [eventId],
      );
      expect(outbox.rows[0]?.dispatched_at).toBeNull();
      expect(outbox.rows[0]?.attempt_count).toBe(0);
      // Backfilled by the migration default: ordering works immediately.
      expect(outbox.rows[0]?.created_at).toBeInstanceOf(Date);

      const issuesCount = await pool.query(
        `SELECT COUNT(*)::int AS count FROM issues`,
      );
      expect(issuesCount.rows[0]?.count).toBe(0);

      // The dispatcher can still claim the pre-migration outbox row.
      const db = drizzle(pool, { schema });
      const claimed = await db.transaction((tx) =>
        claimPendingOutboxBatch(tx, 10),
      );
      expect(claimed.map((item) => item.eventId)).toEqual([eventId]);
    });
  });
});
