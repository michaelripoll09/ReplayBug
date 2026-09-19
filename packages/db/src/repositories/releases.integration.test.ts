import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../schema.js";
import { ReleaseValidationError } from "../releases.js";
import type { Database } from "./db-types.js";
import {
  countArtifactsByReleaseIds,
  createRelease,
  findArtifactByReleaseAndPath,
  findReleaseByIdInProject,
  findReleaseByProjectAndVersion,
  insertReleaseArtifact,
  listArtifactsByRelease,
  listReleasesByProject,
  ReleaseVersionConflictError,
} from "./releases.js";

/**
 * RS-04 releases + release_artifacts repository behavior against real
 * PostgreSQL on an isolated temporary database (never the shared dev DB).
 *
 * Covers: idempotent create (same version + same metadata returns the
 * existing row, never a duplicate), 409 conflict on differing identity
 * metadata with no silent mutation, cross-project isolation, validator +
 * CHECK rejection of bad versions/SHAs/URLs, deterministic list order, and
 * the artifact primitives (insert/find/list/count + unique path guard).
 * Upsert-if-same-hash / conflict-if-different-hash belong to RS-06.
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

async function releaseCount(project: string, version: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS count FROM releases WHERE project_id = $1 AND version = $2`,
    [project, version],
  );
  return (res.rows[0] as { count: number }).count;
}

beforeAll(async () => {
  const name = `replaybug_rel_${randomBytes(6).toString("hex")}`;
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
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Release Owner', $2)`,
    [authorId, `rel-${authorId.slice(0, 8)}@example.com`],
  );
  const workspaceId = randomUUID();
  await exec(
    `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
     VALUES ($1, 'Release WS', $2, $3)`,
    [workspaceId, `ws-${workspaceId.slice(0, 8)}`, authorId],
  );
  projectId = randomUUID();
  otherProjectId = randomUUID();
  await exec(
    `INSERT INTO projects ("id", "workspace_id", "name", "slug")
     VALUES ($1, $2, 'R1', $3), ($4, $2, 'R2', $5)`,
    [
      projectId,
      workspaceId,
      `r1-${projectId.slice(0, 8)}`,
      otherProjectId,
      `r2-${otherProjectId.slice(0, 8)}`,
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

describe("release repository (real PostgreSQL)", () => {
  it("creates a release with identity metadata", async () => {
    const result = await createRelease(db, {
      projectId,
      version: "web@1.4.2",
      commitSha: "abc1234",
      repositoryUrl: "https://github.com/acme/app",
    });
    expect(result.created).toBe(true);
    expect(result.row.projectId).toBe(projectId);
    expect(result.row.version).toBe("web@1.4.2");
    expect(result.row.commitSha).toBe("abc1234");
    expect(result.row.repositoryUrl).toBe("https://github.com/acme/app");
    expect(result.row.createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent for same version with identical metadata", async () => {
    const first = await createRelease(db, {
      projectId,
      version: "demo@2026.09.18",
      commitSha: "a".repeat(40),
      repositoryUrl: "https://github.com/acme/app",
    });
    expect(first.created).toBe(true);
    const second = await createRelease(db, {
      projectId,
      version: "demo@2026.09.18",
      commitSha: "a".repeat(40),
      repositoryUrl: "https://github.com/acme/app",
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await releaseCount(projectId, "demo@2026.09.18")).toBe(1);
  });

  it("is idempotent when both metadata fields are absent", async () => {
    const first = await createRelease(db, {
      projectId,
      version: "1.4.2",
    });
    expect(first.created).toBe(true);
    const second = await createRelease(db, {
      projectId,
      version: "1.4.2",
      commitSha: null,
      repositoryUrl: null,
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(await releaseCount(projectId, "1.4.2")).toBe(1);
  });

  it("conflicts on differing commit_sha without mutating the row", async () => {
    const original = await createRelease(db, {
      projectId,
      version: "web@2.0.0",
      commitSha: "abc1234",
      repositoryUrl: null,
    });
    const attempt = createRelease(db, {
      projectId,
      version: "web@2.0.0",
      commitSha: "def5678",
      repositoryUrl: null,
    });
    await expect(attempt).rejects.toBeInstanceOf(ReleaseVersionConflictError);
    const stored = await findReleaseByProjectAndVersion(
      db,
      projectId,
      "web@2.0.0",
    );
    expect(stored?.id).toBe(original.row.id);
    expect(stored?.commitSha).toBe("abc1234");
    expect(stored?.repositoryUrl).toBeNull();
    expect(await releaseCount(projectId, "web@2.0.0")).toBe(1);
  });

  it("conflicts when one side adds metadata the other lacks", async () => {
    await createRelease(db, { projectId, version: "web@2.1.0" });
    await expect(
      createRelease(db, {
        projectId,
        version: "web@2.1.0",
        commitSha: "abc1234",
      }),
    ).rejects.toBeInstanceOf(ReleaseVersionConflictError);
    await expect(
      createRelease(db, {
        projectId,
        version: "web@2.1.0",
        repositoryUrl: "https://github.com/acme/app",
      }),
    ).rejects.toBeInstanceOf(ReleaseVersionConflictError);
    const stored = await findReleaseByProjectAndVersion(
      db,
      projectId,
      "web@2.1.0",
    );
    expect(stored?.commitSha).toBeNull();
    expect(stored?.repositoryUrl).toBeNull();
  });

  it("keeps the same version string independent across projects", async () => {
    const a = await createRelease(db, {
      projectId,
      version: "shared@1.0.0",
      commitSha: "aaa1111",
    });
    const b = await createRelease(db, {
      projectId: otherProjectId,
      version: "shared@1.0.0",
      commitSha: "bbb2222",
    });
    expect(a.row.id).not.toBe(b.row.id);
    // Conflicting metadata in project A does not touch project B.
    await expect(
      createRelease(db, {
        projectId,
        version: "shared@1.0.0",
        commitSha: "ccc3333",
      }),
    ).rejects.toBeInstanceOf(ReleaseVersionConflictError);
    const bStored = await findReleaseByProjectAndVersion(
      db,
      otherProjectId,
      "shared@1.0.0",
    );
    expect(bStored?.id).toBe(b.row.id);
    expect(bStored?.commitSha).toBe("bbb2222");
    // Project scoping on find-by-id: the other project cannot see row A.
    expect(await findReleaseByIdInProject(db, otherProjectId, a.row.id)).toBe(
      undefined,
    );
    expect((await findReleaseByIdInProject(db, projectId, a.row.id))?.id).toBe(
      a.row.id,
    );
  });

  it("rejects invalid versions, SHAs and URLs without inserting", async () => {
    const badInputs = [
      { version: "", commitSha: null, repositoryUrl: null },
      { version: "v1.0\n", commitSha: null, repositoryUrl: null },
      { version: "ok@1.0.0", commitSha: "short", repositoryUrl: null },
      {
        version: "ok@1.0.1",
        commitSha: null,
        repositoryUrl: "ftp://example.com/x",
      },
    ];
    for (const input of badInputs) {
      await expect(
        createRelease(db, { projectId, ...input }),
      ).rejects.toBeInstanceOf(ReleaseValidationError);
    }
    expect(await releaseCount(projectId, "ok@1.0.0")).toBe(0);
    expect(await releaseCount(projectId, "ok@1.0.1")).toBe(0);
  });

  it("enforces the SQL CHECK guards even for raw inserts", async () => {
    await expect(
      exec(`INSERT INTO releases ("project_id", "version") VALUES ($1, $2)`, [
        projectId,
        `v${"a".repeat(128)}`,
      ]),
    ).rejects.toThrow();
    await expect(
      exec(
        `INSERT INTO releases ("project_id", "version", "commit_sha") VALUES ($1, $2, $3)`,
        [projectId, "raw@1.0.0", "not-hex"],
      ),
    ).rejects.toThrow();
    await expect(
      exec(
        `INSERT INTO releases ("project_id", "version", "repository_url") VALUES ($1, $2, $3)`,
        [projectId, "raw@1.0.1", "ftp://example.com/x"],
      ),
    ).rejects.toThrow();
    expect(await releaseCount(projectId, "raw@1.0.0")).toBe(0);
  });

  it("lists releases in deterministic created_at, version, id order", async () => {
    const stamp = new Date("2026-09-18T12:00:00.000Z");
    const versions = ["zeta@1.0.0", "alpha@1.0.0", "mid@1.0.0"];
    for (const version of versions) {
      await exec(
        `INSERT INTO releases ("project_id", "version", "created_at") VALUES ($1, $2, $3)`,
        [otherProjectId, version, stamp.toISOString()],
      );
    }
    const listed = await listReleasesByProject(db, otherProjectId);
    const tied = listed.filter((r) => versions.includes(r.version));
    expect(tied.map((r) => r.version)).toEqual([
      "alpha@1.0.0",
      "mid@1.0.0",
      "zeta@1.0.0",
    ]);
    // Stable across calls and scoped to the project.
    const again = await listReleasesByProject(db, otherProjectId);
    expect(again.map((r) => r.id)).toEqual(listed.map((r) => r.id));
    for (const row of listed) {
      expect(row.projectId).toBe(otherProjectId);
    }
  });

  it("stores artifact primitives with a unique path guard per release", async () => {
    const release = await createRelease(db, {
      projectId,
      version: "artifacts@1.0.0",
    });
    const first = await insertReleaseArtifact(db, {
      releaseId: release.row.id,
      artifactPath: "assets/app.js",
      storageKey: `${projectId}/${release.row.id}/hash-a`,
      contentHash: "a".repeat(64),
      sizeBytes: 1024,
      artifactType: "minified_asset",
    });
    expect(first.artifactPath).toBe("assets/app.js");
    expect(first.storageKey).toContain(release.row.id);

    const found = await findArtifactByReleaseAndPath(
      db,
      release.row.id,
      "assets/app.js",
    );
    expect(found?.id).toBe(first.id);
    expect(
      await findArtifactByReleaseAndPath(db, release.row.id, "missing.js"),
    ).toBe(undefined);

    // Same path twice violates the unique guard (upsert semantics: RS-06).
    await expect(
      insertReleaseArtifact(db, {
        releaseId: release.row.id,
        artifactPath: "assets/app.js",
        storageKey: `${projectId}/${release.row.id}/hash-b`,
        contentHash: "b".repeat(64),
        sizeBytes: 2048,
        artifactType: "minified_asset",
      }),
    ).rejects.toThrow();

    // Same hash under another path is fine.
    await insertReleaseArtifact(db, {
      releaseId: release.row.id,
      artifactPath: "assets/app.js.map",
      storageKey: `${projectId}/${release.row.id}/hash-a`,
      contentHash: "a".repeat(64),
      sizeBytes: 4096,
      artifactType: "source_map",
    });

    const listed = await listArtifactsByRelease(db, release.row.id);
    expect(listed.map((a) => a.artifactPath)).toEqual([
      "assets/app.js",
      "assets/app.js.map",
    ]);
    const counts = await countArtifactsByReleaseIds(db, [release.row.id]);
    expect(counts.get(release.row.id)).toBe(2);
    expect(counts.get(randomUUID()) ?? 0).toBe(0);
  });

  it("rejects invalid artifact fields without inserting", async () => {
    const release = await createRelease(db, {
      projectId,
      version: "artifacts@1.0.1",
    });
    const base = {
      releaseId: release.row.id,
      artifactPath: "assets/app.js",
      storageKey: "key",
      contentHash: "a".repeat(64),
      sizeBytes: 10,
      artifactType: "source_map" as const,
    };
    await expect(
      insertReleaseArtifact(db, { ...base, artifactPath: "" }),
    ).rejects.toBeInstanceOf(ReleaseValidationError);
    await expect(
      insertReleaseArtifact(db, { ...base, contentHash: "A".repeat(64) }),
    ).rejects.toBeInstanceOf(ReleaseValidationError);
    await expect(
      insertReleaseArtifact(db, { ...base, sizeBytes: -1 }),
    ).rejects.toBeInstanceOf(ReleaseValidationError);
    await expect(
      insertReleaseArtifact(db, {
        ...base,
        artifactType: "bundle" as "source_map",
      }),
    ).rejects.toBeInstanceOf(ReleaseValidationError);
    expect(await listArtifactsByRelease(db, release.row.id)).toEqual([]);
  });
});
