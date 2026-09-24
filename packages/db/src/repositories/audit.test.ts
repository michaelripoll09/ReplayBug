import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../schema.js";
import type { Database } from "./db-types.js";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  insertAuditLog,
  listAuditByWorkspacePaged,
} from "./audit.js";

/**
 * Audit keyset pagination must survive PostgreSQL microsecond precision.
 *
 * `audit_logs.created_at` is timestamptz (microseconds) while JavaScript
 * Date round-trips milliseconds. Two rows created inside the same
 * millisecond with distinct microseconds must still paginate without loss:
 * page 1 returns the newer row, page 2 returns the older row.
 *
 * No timing, sleeps, or machine-speed dependence: exact timestamps are set
 * with SQL after inserting, so the same-millisecond/microsecond layout is
 * deterministic.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "drizzle");
const ADMIN_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

// Same JavaScript millisecond (…00.123Z), distinct PostgreSQL microseconds.
const NEWER_MICRO = "2026-01-01T00:00:00.123789+00";
const OLDER_MICRO = "2026-01-01T00:00:00.123456+00";
const TIE_STAMP = "2026-02-02T12:34:56.654321+00";

const createdDatabases: string[] = [];
let pool: Pool;
let db: Database;
let workspaceId: string;

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await pool.query(sql, params as unknown[]);
}

async function setCreatedAt(id: string, stamp: string): Promise<void> {
  await exec(
    `UPDATE audit_logs SET created_at = $2::timestamptz WHERE id = $1`,
    [id, stamp],
  );
}

beforeAll(async () => {
  const name = `replaybug_audit_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  createdDatabases.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;

  pool = new Pool({ connectionString: url.toString(), max: 2 });
  const migrator = drizzle(pool);
  await migrate(migrator, { migrationsFolder: MIGRATIONS_DIR });
  db = drizzle(pool, { schema });

  const authorId = randomUUID();
  await exec(
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Audit Author', $2)`,
    [authorId, `audit-${authorId.slice(0, 8)}@example.com`],
  );
  workspaceId = randomUUID();
  await exec(
    `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
     VALUES ($1, 'Audit WS', $2, $3)`,
    [workspaceId, `audit-ws-${workspaceId.slice(0, 8)}`, authorId],
  );
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
  } finally {
    await admin.end();
  }
});

describe("audit keyset cursor precision", () => {
  it("paginates two rows sharing a millisecond but differing in microseconds", async () => {
    const newer = await insertAuditLog(db, {
      workspaceId,
      action: "workspace.updated",
      metadataJson: { which: "newer" },
    });
    const older = await insertAuditLog(db, {
      workspaceId,
      action: "workspace.updated",
      metadataJson: { which: "older" },
    });
    await setCreatedAt(newer.id, NEWER_MICRO);
    await setCreatedAt(older.id, OLDER_MICRO);

    const first = await listAuditByWorkspacePaged(db, {
      workspaceId,
      limit: 1,
    });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.id).toBe(newer.id);
    expect(first.nextCursor).toEqual(expect.any(String));

    const decoded = decodeAuditCursor(first.nextCursor ?? "");
    expect(decoded).not.toBeNull();
    // The cursor must retain PostgreSQL microsecond precision, not the
    // millisecond-truncated JavaScript ISO form (…00.123Z).
    expect(decoded?.createdAt).toContain(".123789");

    if (decoded === null) {
      throw new Error("expected a decodable audit cursor");
    }
    const second = await listAuditByWorkspacePaged(db, {
      workspaceId,
      limit: 1,
      cursor: decoded,
    });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]?.id).toBe(older.id);
    expect(second.rows[0]?.id).not.toBe(first.rows[0]?.id);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps the id tie-break stable for identical timestamps", async () => {
    const first = await insertAuditLog(db, {
      workspaceId,
      action: "project.created",
      metadataJson: { which: "tie-a" },
    });
    const second = await insertAuditLog(db, {
      workspaceId,
      action: "project.created",
      metadataJson: { which: "tie-b" },
    });
    await setCreatedAt(first.id, TIE_STAMP);
    await setCreatedAt(second.id, TIE_STAMP);

    const [lowId, highId] = [first.id, second.id].sort();
    const page1 = await listAuditByWorkspacePaged(db, {
      workspaceId,
      action: "project.created",
      limit: 1,
    });
    expect(page1.rows).toHaveLength(1);
    // created_at DESC, id ASC: the smaller UUID leads on exact ties.
    expect(page1.rows[0]?.id).toBe(lowId);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const tieCursor = decodeAuditCursor(page1.nextCursor ?? "");
    if (tieCursor === null) {
      throw new Error("expected a decodable audit cursor");
    }
    const page2 = await listAuditByWorkspacePaged(db, {
      workspaceId,
      action: "project.created",
      limit: 1,
      cursor: tieCursor,
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]?.id).toBe(highId);
    expect(page2.nextCursor).toBeNull();
  });

  it("still decodes legacy millisecond cursors and rejects malformed ones", () => {
    const legacy = encodeAuditCursor("2026-01-01T00:00:00.123Z", randomUUID());
    const decoded = decodeAuditCursor(legacy);
    expect(decoded?.createdAt).toBe("2026-01-01T00:00:00.123Z");

    expect(decodeAuditCursor("")).toBeNull();
    expect(decodeAuditCursor("!!!not-base64!!!")).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from(
          JSON.stringify({
            v: 999,
            createdAt: "2026-01-01T00:00:00.123Z",
            id: "x",
          }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from(
          JSON.stringify({ v: 1, createdAt: "not-a-date", id: "x" }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toBeNull();
  });
});
