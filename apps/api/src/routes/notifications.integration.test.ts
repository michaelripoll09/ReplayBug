import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "@replaybug/db";
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
    payload: { email, password: PASSWORD, name: "Notify Tester" },
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
 * Block 6 notifications (T11) on real PG: own-only reads, unread filter,
 * pagination, mark-read/read-all idempotency and cross-user isolation.
 */
describe("notifications integration (real PG)", () => {
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
    cookie: string;
    userId: string;
    otherId: string;
    projectId: string;
    issueId: string;
    regressionId: string;
    assignedId: string;
    readId: string;
    otherNoteId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const me = await signup(app, `nme-${stamp}@example.com`);
    const other = await signup(app, `noth-${stamp}@example.com`);
    const cookie = cookiesHeader(me.cookies);

    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: `Note WS ${stamp}` },
    });
    const workspaceId = (wsRes.json() as { id: string }).id;
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: { cookie },
      payload: { name: `Note Proj ${stamp}` },
    });
    const projectId = (projRes.json() as { project: { id: string } }).project
      .id;
    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"b".repeat(64)}', 'sig', 'exception',
               'Notified failure', 'Notified failure', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId],
    );

    const insertNote = async (
      userId: string,
      type: string,
      title: string,
      read: boolean,
    ): Promise<string> => {
      const id = randomUUID();
      await dbClient.pool.query(
        `INSERT INTO notifications
           ("id", "user_id", "workspace_id", "project_id", "issue_id",
            "type", "title", "body", "read_at", "created_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'body', $8, now())`,
        [
          id,
          userId,
          workspaceId,
          projectId,
          issueId,
          type,
          title,
          read ? new Date().toISOString() : null,
        ],
      );
      return id;
    };
    const regressionId = await insertNote(
      me.userId,
      "issue_regression",
      "Regression detected",
      false,
    );
    const assignedId = await insertNote(
      me.userId,
      "issue_assigned",
      "Assigned to you",
      false,
    );
    const readId = await insertNote(
      me.userId,
      "issue_regression",
      "Old regression",
      true,
    );
    const otherNoteId = await insertNote(
      other.userId,
      "issue_assigned",
      "Someone else",
      false,
    );
    return {
      cookie,
      userId: me.userId,
      otherId: other.userId,
      projectId,
      issueId,
      regressionId,
      assignedId,
      readId,
      otherNoteId,
    };
  }

  it("requires authentication for all notification routes", async () => {
    const id = randomUUID();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
    });
    expect(list.statusCode).toBe(401);
    const count = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
    });
    expect(count.statusCode).toBe(401);
    const read = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${id}/read`,
    });
    expect(read.statusCode).toBe(401);
    const all = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
    });
    expect(all.statusCode).toBe(401);
  });

  it("lists own notifications newest-first with unread filter and pages", async () => {
    const { cookie, assignedId, regressionId } = await setup();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ id: string; type: string; readAt: string | null }>;
      nextCursor?: string;
    };
    // Own three only (newest first), never the other user's.
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeUndefined();
    const types = new Map(body.items.map((i) => [i.id, i.type]));
    expect(types.get(regressionId)).toBe("issue_regression");
    expect(types.get(assignedId)).toBe("issue_assigned");

    const unread = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?unreadOnly=true",
      headers: { cookie },
    });
    const ubody = unread.json() as { items: Array<{ id: string }> };
    expect(ubody.items.map((i) => i.id).sort()).toEqual(
      [assignedId, regressionId].sort(),
    );

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=2",
      headers: { cookie },
    });
    const p1 = page1.json() as { items: unknown[]; nextCursor?: string };
    expect(p1.items).toHaveLength(2);
    expect(typeof p1.nextCursor).toBe("string");
    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/notifications?limit=2&cursor=${encodeURIComponent(p1.nextCursor as string)}`,
      headers: { cookie },
    });
    const p2 = page2.json() as { items: unknown[]; nextCursor?: string };
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
  });

  it("reports the unread count for the caller only", async () => {
    const { cookie } = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unreadCount: 2 });
  });

  it("marks single notifications read, idempotently, without touching others", async () => {
    const { cookie, regressionId, otherNoteId } = await setup();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${regressionId}/read`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { readAt: string | null }).readAt).not.toBeNull();

    const again = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${regressionId}/read`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);

    // Another user's notification reads as NOT_FOUND, never 403/200.
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${otherNoteId}/read`,
      headers: { cookie },
    });
    expect(foreign.statusCode).toBe(404);

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/notifications/${randomUUID()}/read`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const count = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: { cookie },
    });
    expect(count.json()).toEqual({ unreadCount: 1 });
  });

  it("marks all notifications read and reports the count", async () => {
    const { cookie } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ marked: 2 });

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: { cookie },
    });
    expect(again.json()).toEqual({ marked: 0 });

    const count = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: { cookie },
    });
    expect(count.json()).toEqual({ unreadCount: 0 });
  });
});
