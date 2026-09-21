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
    payload: { email, password: PASSWORD, name: "Mutation Tester" },
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
 * Block 6 issue mutations (T08) on real PG: status lifecycle + idempotency,
 * assignment with membership checks + notifications, project-local tags,
 * comments with own-edit rule, RBAC enforcement and transactional activity.
 */
describe("issue mutations integration (real PG)", () => {
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
    outsiderId: string;
    projectId: string;
    workspaceId: string;
    issueId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await signup(app, `own-${stamp}@example.com`);
    const member = await signup(app, `mem-${stamp}@example.com`);
    const viewer = await signup(app, `view-${stamp}@example.com`);
    const outsider = await signup(app, `out-${stamp}@example.com`);
    const ownerCookie = cookiesHeader(owner.cookies);

    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie: ownerCookie },
      payload: { name: `Mut WS ${stamp}` },
    });
    const workspaceId = (wsRes.json() as { id: string }).id;
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: { cookie: ownerCookie },
      payload: { name: `Mut Proj ${stamp}` },
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
       VALUES ($1, $2, '${"e".repeat(64)}', 'sig', 'exception',
               'Mutable failure', 'Mutable failure', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId],
    );
    return {
      ownerCookie,
      memberCookie: cookiesHeader(member.cookies),
      memberId: member.userId,
      viewerCookie: cookiesHeader(viewer.cookies),
      outsiderId: outsider.userId,
      projectId,
      workspaceId,
      issueId,
    };
  }

  async function activityTypes(issueId: string): Promise<string[]> {
    const rows = await dbClient.pool.query(
      `SELECT type FROM issue_activity WHERE issue_id = $1 ORDER BY created_at, id`,
      [issueId],
    );
    return rows.rows.map((r: { type: string }) => r.type);
  }

  it("runs the status lifecycle with resolved_at rules and idempotency", async () => {
    const { ownerCookie, memberCookie, viewerCookie, issueId } = await setup();

    const anon = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      payload: { status: "investigating" },
    });
    expect(anon.statusCode).toBe(401);

    const viewerAttempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: viewerCookie },
      payload: { status: "investigating" },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    const investigating = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: memberCookie },
      payload: { status: "investigating" },
    });
    expect(investigating.statusCode).toBe(200);
    expect(investigating.json()).toMatchObject({
      status: "investigating",
      resolvedAt: null,
    });

    // Idempotent repeat: no duplicate activity.
    const repeat = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: memberCookie },
      payload: { status: "investigating" },
    });
    expect(repeat.statusCode).toBe(200);
    expect(await activityTypes(issueId)).toEqual(["status_changed"]);

    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "resolved" },
    });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json() as { resolvedAt: string | null };
    expect(typeof resolvedBody.resolvedAt).toBe("string");

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "open" },
    });
    expect(reopened.json()).toMatchObject({ status: "open", resolvedAt: null });

    const ignored = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "ignored" },
    });
    expect(ignored.json()).toMatchObject({ resolvedAt: null });

    expect(await activityTypes(issueId)).toEqual([
      "status_changed",
      "status_changed",
      "status_changed",
      "status_changed",
    ]);

    const bad = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "closed" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("assigns with membership checks, notifications and no self-noise", async () => {
    const { memberCookie, memberId, viewerCookie, outsiderId, issueId } =
      await setup();

    const assigned = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: memberCookie },
      payload: { userId: memberId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      assignee: { id: memberId },
    });

    // Self-assignment produces no notification (no self-noise).
    const notes = await dbClient.pool.query(
      `SELECT type, user_id FROM notifications WHERE issue_id = $1`,
      [issueId],
    );
    expect(notes.rows).toHaveLength(0);
    expect(await activityTypes(issueId)).toEqual(["assigned"]);

    // Unchanged assignment is a no-op (no duplicate activity).
    const same = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: memberCookie },
      payload: { userId: memberId },
    });
    expect(same.statusCode).toBe(200);
    expect(await activityTypes(issueId)).toEqual(["assigned"]);

    // Non-member assignee leaks nothing: 403, not 404.
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: memberCookie },
      payload: { userId: outsiderId },
    });
    expect(foreign.statusCode).toBe(403);

    // Viewer cannot assign.
    const viewerAttempt = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: viewerCookie },
      payload: { userId: memberId },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    // Unassign.
    const unassigned = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: memberCookie },
      payload: { userId: null },
    });
    expect(unassigned.json()).toMatchObject({ assignee: null });
    expect(await activityTypes(issueId)).toEqual(["assigned", "unassigned"]);
  });

  it("notifies a distinct assignee on assignment", async () => {
    const { ownerCookie, memberId, issueId } = await setup();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/assignee`,
      headers: { cookie: ownerCookie },
      payload: { userId: memberId },
    });
    expect(res.statusCode).toBe(200);
    const notes = await dbClient.pool.query(
      `SELECT type, user_id, read_at FROM notifications WHERE issue_id = $1`,
      [issueId],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({
      type: "issue_assigned",
      user_id: memberId,
      read_at: null,
    });
  });

  it("manages project-local tags with idempotency and cross-project rejection", async () => {
    const { memberCookie, viewerCookie, projectId, issueId } = await setup();

    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/tags`,
      headers: { cookie: memberCookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/tags`,
      headers: { cookie: memberCookie },
      payload: { name: "Needs Triage" },
    });
    expect(created.statusCode).toBe(201);
    const tag = created.json() as { id: string; slug: string };
    expect(tag.slug).toBe("needs-triage");

    // Idempotent duplicate: same row, 200.
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/tags`,
      headers: { cookie: memberCookie },
      payload: { name: "needs_triage" },
    });
    expect(dup.statusCode).toBe(200);
    expect((dup.json() as { id: string }).id).toBe(tag.id);

    const viewerCreate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/tags`,
      headers: { cookie: viewerCookie },
      payload: { name: "Nope" },
    });
    expect(viewerCreate.statusCode).toBe(403);

    // Assign + idempotent re-assign.
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/issues/${issueId}/tags/${tag.id}`,
      headers: { cookie: memberCookie },
    });
    expect(put.statusCode).toBe(200);
    const putAgain = await app.inject({
      method: "PUT",
      url: `/api/v1/issues/${issueId}/tags/${tag.id}`,
      headers: { cookie: memberCookie },
    });
    expect(putAgain.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}`,
      headers: { cookie: memberCookie },
    });
    expect((detail.json() as { tags: Array<{ slug: string }> }).tags).toEqual([
      { id: tag.id, name: "Needs Triage", slug: "needs-triage" },
    ]);

    // Cross-project tag is rejected.
    const other = await setup();
    const cross = await app.inject({
      method: "PUT",
      url: `/api/v1/issues/${other.issueId}/tags/${tag.id}`,
      headers: { cookie: other.ownerCookie },
    });
    expect(cross.statusCode).toBe(404);

    // Unassign + idempotent repeat.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/issues/${issueId}/tags/${tag.id}`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removed: true });
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/api/v1/issues/${issueId}/tags/${tag.id}`,
      headers: { cookie: memberCookie },
    });
    expect(delAgain.json()).toEqual({ removed: false });
  });

  it("creates/lists/edits comments with own-edit rule and activity", async () => {
    const { ownerCookie, memberCookie, viewerCookie, issueId } = await setup();

    const viewerPost = await app.inject({
      method: "POST",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { cookie: viewerCookie },
      payload: { body: "I should not write." },
    });
    expect(viewerPost.statusCode).toBe(403);

    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { cookie: memberCookie },
      payload: { body: "   " },
    });
    expect(empty.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { cookie: memberCookie },
      payload: { body: "First **finding**." },
    });
    expect(created.statusCode).toBe(201);
    const comment = created.json() as {
      id: string;
      bodyMarkdown: string;
      author: { id: string };
    };
    expect(comment.bodyMarkdown).toBe("First **finding**.");

    // Activity references the comment but never stores its body.
    const meta = await dbClient.pool.query(
      `SELECT type, metadata_json FROM issue_activity WHERE issue_id = $1`,
      [issueId],
    );
    expect(meta.rows).toHaveLength(1);
    expect(meta.rows[0]).toMatchObject({ type: "comment_added" });
    expect(JSON.stringify(meta.rows[0].metadata_json)).not.toContain(
      "First **finding**.",
    );

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/comments`,
      headers: { cookie: memberCookie },
    });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: unknown[] }).items;
    expect(items).toHaveLength(1);

    // A workspace owner who did not write the comment cannot edit it.
    const foreign = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/comments/${comment.id}`,
      headers: { cookie: ownerCookie },
      payload: { body: "Hijacked." },
    });
    expect(foreign.statusCode).toBe(403);

    // Owner of the comment edits it.
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/issues/${issueId}/comments/${comment.id}`,
      headers: { cookie: memberCookie },
      payload: { body: "Edited finding." },
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { bodyMarkdown: string }).bodyMarkdown).toBe(
      "Edited finding.",
    );
  });
});
