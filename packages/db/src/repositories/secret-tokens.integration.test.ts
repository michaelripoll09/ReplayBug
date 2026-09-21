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
  generatePublicKey,
  generateSecretToken,
  hashPublicKey,
  hashSecretToken,
} from "../keys-crypto.js";
import {
  findKeyByPrefix,
  insertProjectKey,
  listActiveKeysByProjectAndKind,
  revokeKeyById,
  touchKeyLastUsedAt,
  verifyActiveSecretKey,
  verifyAndTouchSecretKey,
} from "./keys.js";

/**
 * RS-02 secret-token repository behavior against real PostgreSQL on an
 * isolated temporary database (never the shared dev DB).
 *
 * Covers: hash+prefix at rest with no plaintext, prefix lookup, active-only
 * verification, wrong-secret/same-prefix rejection, malformed rejection,
 * revoked rejection, cross-project isolation, public-key separation, and
 * last_used_at updated on successful verification only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "drizzle");
const ADMIN_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

const createdDatabases: string[] = [];
let pool: Pool;
let db: Database;
let projectId: string;
let otherProjectId: string;

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await pool.query(sql, params as unknown[]);
}

beforeAll(async () => {
  const name = `replaybug_sectok_${randomBytes(6).toString("hex")}`;
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
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Secret Owner', $2)`,
    [authorId, `sectok-${authorId.slice(0, 8)}@example.com`],
  );
  const workspaceId = randomUUID();
  await exec(
    `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
     VALUES ($1, 'Secret WS', $2, $3)`,
    [workspaceId, `ws-${workspaceId.slice(0, 8)}`, authorId],
  );
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await exec(
    `INSERT INTO projects ("id", "workspace_id", "name", "slug")
     VALUES ($1, $2, 'P1', $3), ($4, $2, 'P2', $5)`,
    [
      projectId,
      workspaceId,
      `p1-${projectId.slice(0, 8)}`,
      otherProjectId,
      `p2-${otherProjectId.slice(0, 8)}`,
    ],
  );
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

async function createSecretTokenRow(
  project: string,
  name = "ci-token",
): Promise<{ fullToken: string; prefix: string; id: string }> {
  const generated = generateSecretToken();
  const row = await insertProjectKey(db, {
    projectId: project,
    kind: "secret",
    name,
    prefix: generated.prefix,
    keyHash: hashSecretToken(generated.fullToken),
  });
  return {
    fullToken: generated.fullToken,
    prefix: generated.prefix,
    id: row.id,
  };
}

describe("secret-token repository (real PostgreSQL)", () => {
  it("stores only hash+prefix: plaintext is absent from the row", async () => {
    const created = await createSecretTokenRow(projectId, "storage-proof");
    const res = await pool.query(
      `SELECT prefix, key_hash, kind, name FROM project_keys WHERE id = $1`,
      [created.id],
    );
    const row = res.rows[0] as {
      prefix: string;
      key_hash: string;
      kind: string;
      name: string;
    };
    expect(row.kind).toBe("secret");
    expect(row.prefix).toBe(created.prefix);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.key_hash).not.toContain(created.fullToken);
    expect(JSON.stringify(row)).not.toContain(created.fullToken);
  });

  it("verifies the active token and exposes its prefix", async () => {
    const created = await createSecretTokenRow(projectId, "active-verify");
    const verified = await verifyActiveSecretKey(
      db,
      projectId,
      created.fullToken,
    );
    expect(verified?.id).toBe(created.id);
    expect(verified?.prefix).toBe(created.prefix);
    const actives = await listActiveKeysByProjectAndKind(
      db,
      projectId,
      "secret",
    );
    expect(actives.map((r) => r.id)).toContain(created.id);
  });

  it("rejects a wrong secret that reuses the same prefix", async () => {
    const created = await createSecretTokenRow(projectId, "wrong-secret");
    const other = generateSecretToken();
    const forged = `rb_sk_${created.prefix}_${other.fullToken.split("_")[2] ?? ""}`;
    expect(forged).not.toBe(created.fullToken);
    expect(await verifyActiveSecretKey(db, projectId, forged)).toBeNull();
  });

  it("fails closed on malformed candidates", async () => {
    expect(await verifyActiveSecretKey(db, projectId, "garbage")).toBeNull();
    expect(await verifyActiveSecretKey(db, projectId, "")).toBeNull();
  });

  it("rejects revoked tokens", async () => {
    const created = await createSecretTokenRow(projectId, "revoked");
    expect(
      await verifyActiveSecretKey(db, projectId, created.fullToken),
    ).not.toBeNull();
    await revokeKeyById(db, created.id, new Date());
    expect(
      await verifyActiveSecretKey(db, projectId, created.fullToken),
    ).toBeNull();
  });

  it("is project-scoped: a token from another project never verifies", async () => {
    const created = await createSecretTokenRow(projectId, "scoped");
    expect(
      await verifyActiveSecretKey(db, otherProjectId, created.fullToken),
    ).toBeNull();
    // The home project still verifies.
    expect(
      await verifyActiveSecretKey(db, projectId, created.fullToken),
    ).not.toBeNull();
  });

  it("never accepts a public ingest key as a secret token", async () => {
    const generated = generatePublicKey();
    await insertProjectKey(db, {
      projectId,
      kind: "public_ingest",
      name: "public",
      prefix: generated.prefix,
      keyHash: hashPublicKey(generated.fullKey),
    });
    expect(
      await verifyActiveSecretKey(db, projectId, generated.fullKey),
    ).toBeNull();
    // Unknown prefixes also fail without throwing.
    const missing = generateSecretToken();
    expect(
      await verifyActiveSecretKey(db, projectId, missing.fullToken),
    ).toBeNull();
    // findKeyByPrefix still locates the public row: separation happens in
    // the verifier, not in lookup.
    expect((await findKeyByPrefix(db, generated.prefix))?.kind).toBe(
      "public_ingest",
    );
  });

  it("updates last_used_at only on successful verification", async () => {
    const created = await createSecretTokenRow(projectId, "last-used");
    const before = await pool.query(
      `SELECT last_used_at FROM project_keys WHERE id = $1`,
      [created.id],
    );
    expect(
      (before.rows[0] as { last_used_at: Date | null }).last_used_at,
    ).toBeNull();

    const ok = await verifyAndTouchSecretKey(db, projectId, created.fullToken);
    expect(ok?.id).toBe(created.id);
    const afterSuccess = await pool.query(
      `SELECT last_used_at FROM project_keys WHERE id = $1`,
      [created.id],
    );
    const touched = (afterSuccess.rows[0] as { last_used_at: Date | null })
      .last_used_at;
    expect(touched).toBeInstanceOf(Date);

    // Failures must not move the marker.
    const forged = `rb_sk_${created.prefix}_${generateSecretToken().fullToken.split("_")[2] ?? ""}`;
    expect(await verifyAndTouchSecretKey(db, projectId, forged)).toBeNull();
    expect(await verifyAndTouchSecretKey(db, projectId, "garbage")).toBeNull();
    expect(
      await verifyAndTouchSecretKey(db, otherProjectId, created.fullToken),
    ).toBeNull();
    const afterFailures = await pool.query(
      `SELECT last_used_at FROM project_keys WHERE id = $1`,
      [created.id],
    );
    expect(
      (afterFailures.rows[0] as { last_used_at: Date }).last_used_at.getTime(),
    ).toBe((touched as Date).getTime());

    // Direct touch helper sets the marker explicitly.
    const explicit = new Date("2026-01-02T03:04:05.000Z");
    await touchKeyLastUsedAt(db, created.id, explicit);
    const afterTouch = await pool.query(
      `SELECT last_used_at FROM project_keys WHERE id = $1`,
      [created.id],
    );
    expect(
      (afterTouch.rows[0] as { last_used_at: Date }).last_used_at.toISOString(),
    ).toBe(explicit.toISOString());
  });
});
