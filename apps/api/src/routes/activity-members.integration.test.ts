import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipRepo, type DbClient } from "@replaybug/db";
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
    payload: { email, password: PASSWORD, name: "Activity Tester" },
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
  return { cookies, userId: (me.json() as { id: string }).id };
}

/**
 * Block 6 activity timeline + workspace members (T09) on real PG:
 * typed entries with actor summaries and safe metadata, bounded
 * pagination, members-only member reads without management operations.
 */
describe("activity and members integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  async function setup(): Promise<{
    ownerCookie: string;
    memberCookie: string;
    memberId: string;
    viewerCookie: string;
    workspaceId: string;
    projectId: string;
    issueId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await signup(app, `aown-${stamp}@example.com`);
    const member = await signup(app, `amem-${stamp}@example.com`);
    const viewer = await signup(app, `aview-${stamp}@example.com`);
    const ownerCookie = cookiesHeader(owner.cookies);

    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie: ownerCookie },
      payload: { name: `Act WS ${stamp}` },
    });
    const workspaceId = (wsRes.json() as { id: string }).id;
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: { cookie: ownerCookie },
      payload: { name: `Act Proj ${stamp}` },
    });
    const projectId = (projRes.json() as { project: { id: string } }).project
      .id;

    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId,
      userId: member.userId,
      role: "member",
    });
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId,
      userId: viewer.userId,
      role: "viewer",
    });

    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"f".repeat(64)}', 'sig', 'exception',
               'Active failure', 'Active failure', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId],
    );
    return {
      ownerCookie,
      memberCookie: cookiesHeader(member.cookies),
      memberId: member.userId,
      viewerCookie: cookiesHeader(viewer.cookies),
      workspaceId,
      projectId,
      issueId,
    };
  }

  it("requires authentication for activity and members", async () => {
    const id = randomUUID();
    const activity = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${id}/activity`,
    });
    expect(activity.statusCode).toBe(401);
    const members = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${id}/members`,
    });
    expect(members.statusCode).toBe(401);
  });

  it("returns typed activity with actor summaries and safe metadata", async () => {
    const { memberCookie, memberId, issueId } = await setup();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: memberCookie },
      payload: { status: "investigating" },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { cookie: memberCookie },
      payload: { body: "Looking closer." },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: memberCookie },
      payload: { userId: memberId },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/activity`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{
        type: string;
        actor: { id: string } | null;
        metadata: Record<string, unknown>;
      }>;
      nextCursor?: string;
    };
    // Newest-first: assigned, comment_added, status_changed.
    expect(body.items.map((i) => i.type)).toEqual([
      "assigned",
      "comment_added",
      "status_changed",
    ]);
    for (const item of body.items) {
      expect(item.actor).toMatchObject({ id: memberId });
    }
    expect(body.items[0]?.metadata).toEqual({ userId: memberId });
    expect(body.items[1]?.metadata).toEqual({
      commentId: expect.any(String),
    });
    expect(body.items[2]?.metadata).toEqual({
      from: "open",
      to: "investigating",
    });
    // Comment bodies never appear in activity metadata.
    expect(JSON.stringify(body)).not.toContain("Looking closer.");
    expect(body.nextCursor).toBeUndefined();

    // Bounded pagination.
    const page1 = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/activity?limit=2`,
      headers: { cookie: memberCookie },
    });
    const p1 = page1.json() as {
      items: Array<{ type: string }>;
      nextCursor?: string;
    };
    expect(p1.items.map((i) => i.type)).toEqual(["assigned", "comment_added"]);
    expect(typeof p1.nextCursor).toBe("string");
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/activity?limit=2&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
      headers: { cookie: memberCookie },
    });
    const p2 = page2.json() as {
      items: Array<{ type: string }>;
      nextCursor?: string;
    };
    expect(p2.items.map((i) => i.type)).toEqual(["status_changed"]);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("hides cross-tenant activity as NOT_FOUND", async () => {
    const seeded = await setup();
    const stranger = await signup(app, `stranger-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${seeded.issueId}/activity`,
      headers: { cookie: cookiesHeader(stranger.cookies) },
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists workspace members for members with minimal safe fields", async () => {
    const { memberCookie, viewerCookie, memberId, workspaceId } = await setup();

    for (const cookie of [memberCookie, viewerCookie]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/workspaces/${workspaceId}/members`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const items = res.json() as Array<{
        id: string;
        name: string;
        email: string;
        role: string;
      }>;
      expect(items).toHaveLength(3);
      const roles = new Map(items.map((m) => [m.role, m]));
      expect(roles.get("member")).toMatchObject({ id: memberId });
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(
          ["email", "id", "name", "role"].sort(),
        );
      }
    }
  });

  it("hides member lists from outsiders as NOT_FOUND", async () => {
    const { workspaceId } = await setup();
    const stranger = await signup(app, `mstranger-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: { cookie: cookiesHeader(stranger.cookies) },
    });
    expect(res.statusCode).toBe(404);
  });
});
