import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TagRepo, type Database, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

async function signup(
  app: AppInstance,
  email: string,
): Promise<{ cookies: string[]; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Issue Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : raw !== undefined
      ? [String(raw)]
      : [];
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: cookiesHeader(cookies) },
  });
  const body = me.json() as { id: string };
  return { cookies, userId: body.id };
}

async function createWorkspaceAndProject(
  app: AppInstance,
  cookie: string,
  name: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: `${name} WS` },
  });
  if (wsRes.statusCode !== 201) {
    throw new Error(`workspace failed ${wsRes.statusCode}: ${wsRes.body}`);
  }
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: `${name} Proj` },
  });
  if (projRes.statusCode !== 201) {
    throw new Error(`project failed ${projRes.statusCode}: ${projRes.body}`);
  }
  const created = projRes.json() as { project: { id: string } };
  return { workspaceId: ws.id, projectId: created.project.id };
}

interface IssueFixture {
  fingerprint: string;
  type: string;
  title: string;
  message: string;
  status: string;
  severity: string;
  assignee: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  sessions: number;
  release: string | null;
}

async function insertIssue(
  dbClient: DbClient,
  projectId: string,
  f: IssueFixture,
): Promise<string> {
  const id = randomUUID();
  await dbClient.pool.query(
    `INSERT INTO issues ("id", "project_id", "fingerprint",
       "fingerprint_signature", "type", "title", "normalized_message",
       "status", "severity", "assigned_to_user_id",
       "first_seen_at", "last_seen_at",
       "first_release", "last_release",
       "occurrence_count", "affected_session_count")
     VALUES ($1, $2, $3, 'sig', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      projectId,
      f.fingerprint,
      f.type,
      f.title,
      f.message,
      f.status,
      f.severity,
      f.assignee,
      f.firstSeen,
      f.lastSeen,
      f.release,
      f.release,
      f.occurrences,
      f.sessions,
    ],
  );
  return id;
}

async function tagIssue(
  db: Database,
  projectId: string,
  issueId: string,
  name: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    let tag = await TagRepo.findTagBySlug(tx, projectId, "frontend");
    if (tag === undefined && name === "Frontend") {
      tag = await TagRepo.insertTagIfAbsent(tx, { projectId, name });
      if (tag === undefined) {
        tag = await TagRepo.findTagBySlug(tx, projectId, "frontend");
      }
    }
    if (tag === undefined) {
      throw new Error("tag fixture failed");
    }
    await TagRepo.assignTagToIssue(tx, issueId, tag.id);
  });
}

/**
 * Block 6 issues list (T04) against real PostgreSQL: auth, tenant isolation,
 * filters, sort stability, bounded pagination, DTO shape and tag summaries.
 */
describe("issues list integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let db: Database;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    db = dbClient.db;
    app = await buildApp({ config: testApiConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${randomUUID()}/issues`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("returns NOT_FOUND for unknown projects (anti-enumeration)", async () => {
    const { cookies } = await signup(app, `iso-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${randomUUID()}/issues`,
      headers: { cookie: cookiesHeader(cookies) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("isolates tenants: another workspace project reads as NOT_FOUND", async () => {
    const a = await signup(app, `ten-a-${Date.now()}@example.com`);
    const b = await signup(app, `ten-b-${Date.now()}@example.com`);
    const pb = await createWorkspaceAndProject(
      app,
      cookiesHeader(b.cookies),
      "TenantB",
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pb.projectId}/issues`,
      headers: { cookie: cookiesHeader(a.cookies) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists an empty project without a cursor", async () => {
    const { cookies } = await signup(app, `empty-${Date.now()}@example.com`);
    const { projectId } = await createWorkspaceAndProject(
      app,
      cookiesHeader(cookies),
      "Empty",
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues`,
      headers: { cookie: cookiesHeader(cookies) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("filters, sorts and paginates with tag summaries and no leak fields", async () => {
    const { cookies, userId } = await signup(
      app,
      `list-${Date.now()}@example.com`,
    );
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie, "List");

    const fp = (c: string): string => c.repeat(64);
    const alpha = await insertIssue(dbClient, projectId, {
      fingerprint: fp("a"),
      type: "exception",
      title: "Alpha failure",
      message: "Alpha failure",
      status: "open",
      severity: "error",
      assignee: userId,
      firstSeen: "2026-09-10T10:00:00.000Z",
      lastSeen: "2026-09-12T10:00:00.000Z",
      occurrences: 5,
      sessions: 3,
      release: "web@1.0.0",
    });
    await insertIssue(dbClient, projectId, {
      fingerprint: fp("b"),
      type: "network",
      title: "Beta timeout",
      message: "Beta timeout",
      status: "resolved",
      severity: "error",
      assignee: null,
      firstSeen: "2026-09-11T10:00:00.000Z",
      lastSeen: "2026-09-13T10:00:00.000Z",
      occurrences: 2,
      sessions: 2,
      release: "web@1.0.1",
    });
    await tagIssue(db, projectId, alpha, "Frontend");

    // Status filter.
    const open = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?status=open`,
      headers: { cookie },
    });
    expect(open.statusCode).toBe(200);
    const openBody = open.json() as { items: Array<{ title: string }> };
    expect(openBody.items.map((i) => i.title)).toEqual(["Alpha failure"]);

    // Type + unassigned filters.
    const network = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?type=network&unassigned=true`,
      headers: { cookie },
    });
    expect((network.json() as { items: unknown[] }).items).toHaveLength(1);

    // Assignee filter.
    const assigned = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?assigneeId=${userId}`,
      headers: { cookie },
    });
    expect(
      (assigned.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Alpha failure"]);

    // Tag filter + embedded tag summaries.
    const tagged = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?tag=frontend`,
      headers: { cookie },
    });
    const taggedBody = tagged.json() as {
      items: Array<{ title: string; tags: Array<{ slug: string }> }>;
    };
    expect(taggedBody.items.map((i) => i.title)).toEqual(["Alpha failure"]);
    expect(taggedBody.items[0]?.tags).toEqual([
      { id: expect.any(String), name: "Frontend", slug: "frontend" },
    ]);

    // Release + date filters.
    const rel = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?release=web@1.0.1`,
      headers: { cookie },
    });
    expect(
      (rel.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Beta timeout"]);
    const dated = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?since=2026-09-12T12:00:00.000Z`,
      headers: { cookie },
    });
    expect(
      (dated.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Beta timeout"]);

    // Free-text search.
    const search = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?q=alpha`,
      headers: { cookie },
    });
    expect(
      (search.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Alpha failure"]);

    // Sort by occurrences ascending + stable ordering.
    const sorted = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?sort=occurrence_count&order=asc`,
      headers: { cookie },
    });
    expect(
      (sorted.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      ),
    ).toEqual(["Beta timeout", "Alpha failure"]);

    // Bounded pagination with cursor.
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?limit=1`,
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json() as {
      items: Array<{ id: string; title: string }>;
      nextCursor?: string;
    };
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]?.title).toBe("Beta timeout");
    expect(typeof p1.nextCursor).toBe("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?limit=1&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
      headers: { cookie },
    });
    const p2 = page2.json() as {
      items: Array<{ title: string }>;
      nextCursor?: string;
    };
    expect(p2.items.map((i) => i.title)).toEqual(["Alpha failure"]);
    expect(p2.nextCursor).toBeUndefined();

    // DTO shape: no fingerprint material, no payloads; assignee summary.
    const detail = p1.items[0];
    const full = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?sort=last_seen&order=desc&limit=10`,
      headers: { cookie },
    });
    const beta = (full.json() as { items: Array<Record<string, unknown>> })
      .items[0] as Record<string, unknown>;
    expect(beta).not.toHaveProperty("fingerprint");
    expect(beta).not.toHaveProperty("fingerprintSignature");
    expect(beta).not.toHaveProperty("payload_json");
    expect(beta).not.toHaveProperty("payloadJson");
    expect(detail?.id).toBe(beta["id"]);
  });

  it("rejects invalid cursors and bad query values with 400", async () => {
    const { cookies } = await signup(app, `badq-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie, "BadQ");
    const badCursor = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?cursor=not-a-cursor`,
      headers: { cookie },
    });
    expect(badCursor.statusCode).toBe(400);
    const badSort = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/issues?sort=bogus`,
      headers: { cookie },
    });
    expect(badSort.statusCode).toBe(400);
  });

  it("searches typo-tolerantly, case-insensitively and across tag names", async () => {
    const { cookies } = await signup(app, `search-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(
      app,
      cookie,
      "Search",
    );

    const fp = (c: string): string => c.repeat(64);
    const alpha = await insertIssue(dbClient, projectId, {
      fingerprint: fp("d"),
      type: "exception",
      title: "Checkout payment failure",
      message: "Checkout payment failure",
      status: "open",
      severity: "error",
      assignee: null,
      firstSeen: "2026-09-10T10:00:00.000Z",
      lastSeen: "2026-09-12T10:00:00.000Z",
      occurrences: 4,
      sessions: 2,
      release: null,
    });
    await insertIssue(dbClient, projectId, {
      fingerprint: fp("e"),
      type: "network",
      title: "Profile avatar upload timeout",
      message: "Profile avatar upload timeout",
      status: "open",
      severity: "error",
      assignee: null,
      firstSeen: "2026-09-10T10:00:00.000Z",
      lastSeen: "2026-09-12T10:00:00.000Z",
      occurrences: 1,
      sessions: 1,
      release: null,
    });
    await tagIssue(db, projectId, alpha, "Frontend");

    async function titles(q: string): Promise<string[]> {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/issues?q=${encodeURIComponent(q)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { items: Array<{ title: string }> }).items.map(
        (i) => i.title,
      );
    }

    // Typo tolerance (transposed letters) via pg_trgm.
    expect(await titles("Chekout paymnt failure")).toEqual([
      "Checkout payment failure",
    ]);
    // Case-insensitive exact match.
    expect(await titles("CHECKOUT")).toEqual(["Checkout payment failure"]);
    // Tag-name match: the issue carries the Frontend tag.
    expect(await titles("frontend")).toEqual(["Checkout payment failure"]);
    // No match returns an empty list, not an error.
    expect(await titles("zzzz-no-such-thing")).toEqual([]);
  });

  it("never leaks issues across projects through search", async () => {
    const { cookies } = await signup(app, `leak-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const pa = await createWorkspaceAndProject(app, cookie, "LeakA");
    const pb = await createWorkspaceAndProject(app, cookie, "LeakB");

    const fp = (c: string): string => c.repeat(64);
    await insertIssue(dbClient, pb.projectId, {
      fingerprint: fp("f"),
      type: "exception",
      title: "Secret vault explosion",
      message: "Secret vault explosion",
      status: "open",
      severity: "error",
      assignee: null,
      firstSeen: "2026-09-10T10:00:00.000Z",
      lastSeen: "2026-09-12T10:00:00.000Z",
      occurrences: 1,
      sessions: 1,
      release: null,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${pa.projectId}/issues?q=vault`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items).toEqual([]);
  });

  it("paginates sort ties stably without duplicates or skips", async () => {
    const { cookies } = await signup(app, `ties-${Date.now()}@example.com`);
    const cookie = cookiesHeader(cookies);
    const { projectId } = await createWorkspaceAndProject(app, cookie, "Ties");

    // Five issues sharing the exact same last_seen second: only the id
    // tiebreak keeps pages stable.
    const fp = (c: string): string => c.repeat(64);
    const chars = ["0", "1", "2", "3", "4"];
    for (const [index, c] of chars.entries()) {
      await insertIssue(dbClient, projectId, {
        fingerprint: fp(c),
        type: "exception",
        title: `Tie ${index}`,
        message: `Tie ${index}`,
        status: "open",
        severity: "error",
        assignee: null,
        firstSeen: "2026-09-10T10:00:00.000Z",
        lastSeen: "2026-09-12T10:00:00.000Z",
        occurrences: index,
        sessions: 1,
        release: null,
      });
    }

    async function walkAll(): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const url =
          `/api/v1/projects/${projectId}/issues?limit=2` +
          (cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const res = await app.inject({
          method: "GET",
          url,
          headers: { cookie },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          items: Array<{ id: string }>;
          nextCursor?: string;
        };
        ids.push(...body.items.map((i) => i.id));
        if (body.nextCursor === undefined) {
          break;
        }
        cursor = body.nextCursor;
      }
      return ids;
    }

    const first = await walkAll();
    expect(first).toHaveLength(5);
    expect(new Set(first).size).toBe(5);
    // Repeat walk returns the identical order (stable, no flapping).
    expect(await walkAll()).toEqual(first);
  });
});
