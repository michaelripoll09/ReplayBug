import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Forward-only migration tests against real PostgreSQL.
 *
 * A. Upgrade path: temporary database at the Block 3 schema state, real
 *    fixture rows, then the Block 4 migration is applied and the fixture must
 *    survive while the telemetry tables appear.
 * B. Empty database: full migration run from 0000 to latest, expected schema
 *    checks, and a second migrate run must be a clean no-op.
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
  it("upgrades a Block 3 database to Block 4 preserving existing data", async () => {
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

      // 5. New telemetry tables exist.
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [TELEMETRY_TABLES],
      );
      expect(
        tables.rows.map((r: { table_name: string }) => r.table_name).sort(),
      ).toEqual([...TELEMETRY_TABLES].sort());
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
      // One journal row per migration file (0000 + 0001), never duplicated.
      expect(journal.rows[0]?.count).toBe(2);
    });
  });
});
