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
  assignTagToIssue,
  findTagBySlug,
  insertTagIfAbsent,
  listTagsByProject,
  listTagsForIssue,
  listTagsForIssues,
  normalizeTagSlug,
  unassignTagFromIssue,
} from "./tags.js";
import {
  ISSUE_COMMENT_MAX_LENGTH,
  countCommentsByIssue,
  deleteComment,
  findCommentById,
  insertIssueComment,
  listCommentsByIssue,
  updateCommentBody,
} from "./comments.js";
import { insertIssueIfAbsent } from "./issues.js";

/**
 * Tags/comments repository behavior against real PostgreSQL on an isolated
 * temporary database (never the shared dev DB): FK enforcement, project-local
 * slug uniqueness, idempotent assignment, batch lookup without N+1, and the
 * comment length bound.
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
let issueId: string;
let otherIssueId: string;
let authorId: string;

async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await pool.query(sql, params as unknown[]);
}

beforeAll(async () => {
  const name = `replaybug_tags_${randomBytes(6).toString("hex")}`;
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

  authorId = randomUUID();
  await exec(
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Tag Author', $2)`,
    [authorId, `tags-${authorId.slice(0, 8)}@example.com`],
  );
  const workspaceId = randomUUID();
  await exec(
    `INSERT INTO workspaces ("id", "name", "slug", "created_by_user_id")
     VALUES ($1, 'WS', $2, $3)`,
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
  const now = new Date();
  const first = await db.transaction((tx) =>
    insertIssueIfAbsent(tx, {
      projectId,
      fingerprint: "b".repeat(64),
      fingerprintSignature: "sig",
      type: "exception",
      title: "Boom",
      normalizedMessage: "Boom",
      severity: "error",
      firstSeenAt: now,
      release: null,
    }),
  );
  const second = await db.transaction((tx) =>
    insertIssueIfAbsent(tx, {
      projectId,
      fingerprint: "c".repeat(64),
      fingerprintSignature: "sig2",
      type: "exception",
      title: "Bang",
      normalizedMessage: "Bang",
      severity: "error",
      firstSeenAt: now,
      release: null,
    }),
  );
  if (first === undefined || second === undefined) {
    throw new Error("fixture issues not created");
  }
  issueId = first.id;
  otherIssueId = second.id;
}, 60_000);

afterAll(async () => {
  await pool?.end();
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    for (const name of createdDatabases) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

describe("issue tags repository", () => {
  it("creates a tag and finds it by deterministic slug", async () => {
    const created = await db.transaction((tx) =>
      insertTagIfAbsent(tx, { projectId, name: "Needs Triage" }),
    );
    expect(created?.slug).toBe("needs-triage");
    const found = await findTagBySlug(db, projectId, "needs-triage");
    expect(found?.id).toBe(created?.id);
  });

  it("treats a concurrent duplicate slug as absent (caller re-reads)", async () => {
    const duplicate = await db.transaction((tx) =>
      insertTagIfAbsent(tx, { projectId, name: "needs_triage" }),
    );
    expect(duplicate).toBeUndefined();
    const canonical = await findTagBySlug(db, projectId, "needs-triage");
    expect(canonical).toBeDefined();
  });

  it("scopes identical slugs to different projects", async () => {
    const other = await db.transaction((tx) =>
      insertTagIfAbsent(tx, {
        projectId: otherProjectId,
        name: "Needs Triage",
      }),
    );
    expect(other?.slug).toBe("needs-triage");
    expect(other?.projectId).toBe(otherProjectId);
  });

  it("assigns idempotently and unassigns", async () => {
    const tag = await findTagBySlug(db, projectId, "needs-triage");
    if (tag === undefined) {
      throw new Error("tag fixture missing");
    }
    await expect(
      db.transaction((tx) => assignTagToIssue(tx, issueId, tag.id)),
    ).resolves.toBe(true);
    await expect(
      db.transaction((tx) => assignTagToIssue(tx, issueId, tag.id)),
    ).resolves.toBe(false);
    expect(await listTagsForIssue(db, issueId)).toHaveLength(1);
    await expect(
      db.transaction((tx) => unassignTagFromIssue(tx, issueId, tag.id)),
    ).resolves.toBe(true);
    await expect(
      db.transaction((tx) => unassignTagFromIssue(tx, issueId, tag.id)),
    ).resolves.toBe(false);
    expect(await listTagsForIssue(db, issueId)).toHaveLength(0);
  });

  it("batch-loads tags for many issues in one call", async () => {
    const tag = await findTagBySlug(db, projectId, "needs-triage");
    if (tag === undefined) {
      throw new Error("tag fixture missing");
    }
    await db.transaction((tx) => assignTagToIssue(tx, issueId, tag.id));
    const extra = await db.transaction((tx) =>
      insertTagIfAbsent(tx, { projectId, name: "Backend" }),
    );
    if (extra === undefined) {
      throw new Error("extra tag not created");
    }
    await db.transaction((tx) => assignTagToIssue(tx, otherIssueId, extra.id));

    const byIssue = await listTagsForIssues(db, [issueId, otherIssueId]);
    expect(byIssue.get(issueId)?.map((t) => t.slug)).toEqual(["needs-triage"]);
    expect(byIssue.get(otherIssueId)?.map((t) => t.slug)).toEqual(["backend"]);

    const projects = await listTagsByProject(db, projectId);
    expect(projects.map((t) => t.name)).toEqual(["Backend", "Needs Triage"]);
    expect(normalizeTagSlug("  Mixed_CASE Name ")).toBe("mixed-case-name");
  });
});

describe("issue comments repository", () => {
  it("inserts, lists oldest-first, counts, edits and deletes", async () => {
    const first = await db.transaction((tx) =>
      insertIssueComment(tx, {
        issueId,
        authorUserId: authorId,
        bodyMarkdown: "First **finding**.",
      }),
    );
    const second = await db.transaction((tx) =>
      insertIssueComment(tx, {
        issueId,
        authorUserId: authorId,
        bodyMarkdown: "Second finding.",
      }),
    );
    if (first === undefined || second === undefined) {
      throw new Error("comments not created");
    }

    const listed = await listCommentsByIssue(db, issueId);
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(await countCommentsByIssue(db, issueId)).toBe(2);

    const edited = await db.transaction((tx) =>
      updateCommentBody(tx, first.id, "Edited finding."),
    );
    expect(edited?.bodyMarkdown).toBe("Edited finding.");
    expect(edited?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first.updatedAt.getTime(),
    );

    expect(await findCommentById(db, second.id)).toBeDefined();
    await expect(
      db.transaction((tx) => deleteComment(tx, second.id)),
    ).resolves.toBe(true);
    expect(await countCommentsByIssue(db, issueId)).toBe(1);
  });

  it("rejects bodies over the length bound", async () => {
    expect(ISSUE_COMMENT_MAX_LENGTH).toBe(10_000);
    await expect(
      db.transaction((tx) =>
        insertIssueComment(tx, {
          issueId,
          authorUserId: authorId,
          bodyMarkdown: "x".repeat(ISSUE_COMMENT_MAX_LENGTH + 1),
        }),
      ),
    ).rejects.toThrow();
  });
});
