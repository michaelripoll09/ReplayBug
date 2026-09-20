import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditRepo, MembershipRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

type SignedInUser = {
  cookies: string[];
  userId: string;
  email: string;
  name: string;
};

type Hierarchy = {
  owner: SignedInUser;
  admin: SignedInUser;
  member: SignedInUser;
  viewer: SignedInUser;
  workspaceId: string;
};

let sequence = 0;

function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@example.com`;
}

async function signup(
  app: AppInstance,
  email: string,
  name: string,
): Promise<SignedInUser> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name },
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`signup failed ${response.statusCode}: ${response.body}`);
  }
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : raw === undefined
      ? []
      : [String(raw)];
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: cookiesHeader(cookies) },
  });
  const user = me.json() as { id: string; email: string; name: string };
  return { cookies, userId: user.id, email: user.email, name: user.name };
}

function cookieHeader(user: SignedInUser): string {
  return cookiesHeader(user.cookies);
}

async function createWorkspace(
  app: AppInstance,
  owner: SignedInUser,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie: cookieHeader(owner) },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function addMembership(
  dbClient: DbClient,
  workspaceId: string,
  userId: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  await MembershipRepo.insertMembership(dbClient.db, {
    workspaceId,
    userId,
    role,
  });
}

async function setupHierarchy(
  app: AppInstance,
  dbClient: DbClient,
): Promise<Hierarchy> {
  const stamp = `${Date.now()}-${sequence}`;
  const owner = await signup(app, uniqueEmail("gov-owner"), "Governance Owner");
  const admin = await signup(app, uniqueEmail("gov-admin"), "Governance Admin");
  const member = await signup(
    app,
    uniqueEmail("gov-member"),
    "Governance Member",
  );
  const viewer = await signup(
    app,
    uniqueEmail("gov-viewer"),
    "Governance Viewer",
  );
  const workspaceId = await createWorkspace(app, owner, `Governance ${stamp}`);
  await addMembership(dbClient, workspaceId, admin.userId, "admin");
  await addMembership(dbClient, workspaceId, member.userId, "member");
  await addMembership(dbClient, workspaceId, viewer.userId, "viewer");
  return { owner, admin, member, viewer, workspaceId };
}

function errorCode(response: { json: () => unknown }): string | undefined {
  const body = response.json() as { code?: unknown };
  return typeof body.code === "string" ? body.code : undefined;
}

describe("workspace governance integration (real PG)", () => {
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

  it("preserves the member list route and enforces the owner/admin/member/viewer hierarchy", async () => {
    const { owner, admin, member, viewer, workspaceId } = await setupHierarchy(
      app,
      dbClient,
    );

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: { cookie: cookieHeader(member) },
    });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as Array<{ id: string }>).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        owner.userId,
        admin.userId,
        member.userId,
        viewer.userId,
      ]),
    );

    const adminChangesMember = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { role: "viewer" },
    });
    expect(adminChangesMember.statusCode).toBe(200);
    expect((adminChangesMember.json() as { role: string }).role).toBe("viewer");

    const adminCannotGrantAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { role: "admin" },
    });
    expect(adminCannotGrantAdmin.statusCode).toBe(403);
    expect(errorCode(adminCannotGrantAdmin)).toBe("FORBIDDEN");

    const memberCannotManage = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${viewer.userId}`,
      headers: { cookie: cookieHeader(member) },
      payload: { role: "member" },
    });
    expect(memberCannotManage.statusCode).toBe(403);

    const viewerCannotManage = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(viewer) },
    });
    expect(viewerCannotManage.statusCode).toBe(403);

    const adminCannotChangeOwner = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${owner.userId}`,
      headers: { cookie: cookieHeader(admin) },
      payload: { role: "admin" },
    });
    expect(adminCannotChangeOwner.statusCode).toBe(403);

    const adminRemovesViewer = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/members/${viewer.userId}`,
      headers: { cookie: cookieHeader(admin) },
    });
    expect(adminRemovesViewer.statusCode).toBe(200);
    expect(adminRemovesViewer.json()).toEqual({ removed: true });

    const adminRemovesMember = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(admin) },
    });
    expect(adminRemovesMember.statusCode).toBe(200);

    const adminCannotRemoveOwner = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/members/${owner.userId}`,
      headers: { cookie: cookieHeader(admin) },
    });
    expect(adminCannotRemoveOwner.statusCode).toBe(403);
  });

  it("allows non-owners to leave, records the leave reason, and protects the last owner", async () => {
    const { owner, member, workspaceId } = await setupHierarchy(app, dbClient);

    const anonymous = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/leave`,
    });
    expect(anonymous.statusCode).toBe(401);

    const ownerLeaves = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/leave`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(ownerLeaves.statusCode).toBe(409);
    expect(errorCode(ownerLeaves)).toBe("CONFLICT");

    const ownerSelfRemove = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/members/${owner.userId}`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(ownerSelfRemove.statusCode).toBe(403);

    const memberLeaves = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/leave`,
      headers: { cookie: cookieHeader(member) },
    });
    expect(memberLeaves.statusCode).toBe(200);
    expect(memberLeaves.json()).toEqual({ left: true });

    const audits = await dbClient.pool.query<{
      action: string;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT action, metadata_json FROM audit_logs
       WHERE workspace_id = $1 AND action = 'workspace_member.removed'`,
      [workspaceId],
    );
    expect(
      audits.rows.some(
        (row) =>
          row.metadata_json["reason"] === "left" &&
          row.action === "workspace_member.removed",
      ),
    ).toBe(true);

    const ownerStillListed = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/members`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(ownerStillListed.statusCode).toBe(200);
    expect(
      (ownerStillListed.json() as Array<{ id: string }>).some(
        (item) => item.id === owner.userId,
      ),
    ).toBe(true);
  });

  it("transfers ownership in one transaction and never creates two owners", async () => {
    const { owner, admin, member, viewer, workspaceId } = await setupHierarchy(
      app,
      dbClient,
    );

    const adminCannotTransfer = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/ownership-transfer`,
      headers: { cookie: cookieHeader(admin) },
      payload: { userId: member.userId },
    });
    expect(adminCannotTransfer.statusCode).toBe(403);

    const transfer = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/ownership-transfer`,
      headers: { cookie: cookieHeader(owner) },
      payload: { userId: member.userId },
    });
    expect(transfer.statusCode).toBe(200);
    expect(transfer.json()).toMatchObject({
      workspaceId,
      previousOwnerId: owner.userId,
      newOwnerId: member.userId,
    });

    const roles = await dbClient.pool.query<{
      user_id: string;
      role: string;
    }>(
      `SELECT user_id, role FROM workspace_memberships
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(roles.rows.filter((row) => row.role === "owner")).toHaveLength(1);
    expect(roles.rows.find((row) => row.user_id === owner.userId)?.role).toBe(
      "admin",
    );
    expect(roles.rows.find((row) => row.user_id === member.userId)?.role).toBe(
      "owner",
    );

    const oldOwnerCannotTransfer = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/ownership-transfer`,
      headers: { cookie: cookieHeader(owner) },
      payload: { userId: viewer.userId },
    });
    expect(oldOwnerCannotTransfer.statusCode).toBe(403);

    const crossTenant = await signup(
      app,
      uniqueEmail("other-tenant"),
      "Other Tenant",
    );
    const otherWorkspaceId = await createWorkspace(
      app,
      crossTenant,
      `Other Workspace ${Date.now()}`,
    );
    const crossTenantTarget = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/ownership-transfer`,
      headers: { cookie: cookieHeader(member) },
      payload: { userId: crossTenant.userId },
    });
    expect(crossTenantTarget.statusCode).toBe(404);
    expect(otherWorkspaceId).not.toBe(workspaceId);
  });

  it("hides cross-tenant members and audit data without revealing resource existence", async () => {
    const first = await setupHierarchy(app, dbClient);
    const outsider = await signup(app, uniqueEmail("outsider"), "Outsider");
    const otherWorkspaceId = await createWorkspace(
      app,
      outsider,
      `Outsider Workspace ${Date.now()}`,
    );

    for (const request of [
      app.inject({
        method: "GET",
        url: `/api/v1/workspaces/${first.workspaceId}/audit`,
        headers: { cookie: cookieHeader(outsider) },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/workspaces/${first.workspaceId}/members/${outsider.userId}`,
        headers: { cookie: cookieHeader(outsider) },
        payload: { role: "viewer" },
      }),
      app.inject({
        method: "DELETE",
        url: `/api/v1/workspaces/${first.workspaceId}/members/${outsider.userId}`,
        headers: { cookie: cookieHeader(outsider) },
      }),
    ]) {
      const response = await request;
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe("NOT_FOUND");
    }

    const ownerTargetsOtherTenantUser = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${first.workspaceId}/members/${outsider.userId}`,
      headers: { cookie: cookieHeader(first.owner) },
      payload: { role: "viewer" },
    });
    expect(ownerTargetsOtherTenantUser.statusCode).toBe(404);

    const outsiderCannotReadOwnOtherAuditAsFirst = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${otherWorkspaceId}/audit`,
      headers: { cookie: cookieHeader(first.owner) },
    });
    expect(outsiderCannotReadOwnOtherAuditAsFirst.statusCode).toBe(404);
  });

  it("serializes concurrent transfer/remove/leave races behind the workspace lock", async () => {
    const first = await setupHierarchy(app, dbClient);
    const transferAndRemove = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${first.workspaceId}/ownership-transfer`,
        headers: { cookie: cookieHeader(first.owner) },
        payload: { userId: first.member.userId },
      }),
      app.inject({
        method: "DELETE",
        url: `/api/v1/workspaces/${first.workspaceId}/members/${first.member.userId}`,
        headers: { cookie: cookieHeader(first.owner) },
      }),
    ]);
    expect(
      transferAndRemove.filter((response) => response.statusCode === 200),
    ).toHaveLength(1);
    expect(
      transferAndRemove.some((response) =>
        [403, 404, 409].includes(response.statusCode),
      ),
    ).toBe(true);

    const firstOwnerCount = await dbClient.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_memberships
       WHERE workspace_id = $1 AND role = 'owner'`,
      [first.workspaceId],
    );
    expect(firstOwnerCount.rows[0]?.count).toBe("1");

    await resetTestDatabase(dbClient);
    const second = await setupHierarchy(app, dbClient);
    const transferAndLeave = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${second.workspaceId}/ownership-transfer`,
        headers: { cookie: cookieHeader(second.owner) },
        payload: { userId: second.member.userId },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${second.workspaceId}/leave`,
        headers: { cookie: cookieHeader(second.member) },
      }),
    ]);
    expect(
      transferAndLeave.filter((response) => response.statusCode === 200),
    ).toHaveLength(1);
    expect(
      transferAndLeave.some((response) =>
        [404, 409].includes(response.statusCode),
      ),
    ).toBe(true);

    const secondOwnerCount = await dbClient.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_memberships
       WHERE workspace_id = $1 AND role = 'owner'`,
      [second.workspaceId],
    );
    expect(secondOwnerCount.rows[0]?.count).toBe("1");

    await resetTestDatabase(dbClient);
    const third = await setupHierarchy(app, dbClient);
    const concurrentTransfers = await Promise.all(
      [third.member, third.viewer].map((target) =>
        app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${third.workspaceId}/ownership-transfer`,
          headers: { cookie: cookieHeader(third.owner) },
          payload: { userId: target.userId },
        }),
      ),
    );
    expect(
      concurrentTransfers.filter((response) => response.statusCode === 200),
    ).toHaveLength(1);
    expect(
      concurrentTransfers.some((response) => response.statusCode === 403),
    ).toBe(true);
    const thirdOwnerCount = await dbClient.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_memberships
       WHERE workspace_id = $1 AND role = 'owner'`,
      [third.workspaceId],
    );
    expect(thirdOwnerCount.rows[0]?.count).toBe("1");
  });

  it("provides owner/admin-only newest-first audit pages, filters, actors, and safe metadata", async () => {
    const { owner, admin, member, workspaceId } = await setupHierarchy(
      app,
      dbClient,
    );

    const firstRoleChange = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(owner) },
      payload: { role: "viewer" },
    });
    expect(firstRoleChange.statusCode).toBe(200);
    const secondRoleChange = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/members/${member.userId}`,
      headers: { cookie: cookieHeader(owner) },
      payload: { role: "member" },
    });
    expect(secondRoleChange.statusCode).toBe(200);

    await AuditRepo.insertAuditLog(dbClient.db, {
      workspaceId,
      actorUserId: owner.userId,
      action: "workspace.updated",
      metadataJson: {
        visible: "safe",
        token: "rb_inv_plaintext-secret",
        tokenHash: "a".repeat(64),
        nested: [{ cookie: "session-cookie" }],
        huge: "x".repeat(10_000),
      },
    });

    const memberAudit = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit`,
      headers: { cookie: cookieHeader(member) },
    });
    expect(memberAudit.statusCode).toBe(403);

    const filteredFirst = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit?action=workspace_member.role_changed&limit=1`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(filteredFirst.statusCode).toBe(200);
    const firstPage = filteredFirst.json() as {
      items: Array<{
        id: string;
        action: string;
        actor: { id: string; email: string; name: string } | null;
        metadata: Record<string, unknown>;
        createdAt: string;
      }>;
      nextCursor?: string;
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.action).toBe("workspace_member.role_changed");
    expect(firstPage.items[0]?.actor).toMatchObject({
      id: owner.userId,
      email: owner.email,
      name: owner.name,
    });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const filteredSecond = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit?action=workspace_member.role_changed&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(filteredSecond.statusCode).toBe(200);
    const secondPage = filteredSecond.json() as {
      items: Array<{ id: string; createdAt: string }>;
      nextCursor?: string;
    };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    const firstCreatedAt = firstPage.items[0]?.createdAt;
    const secondCreatedAt = secondPage.items[0]?.createdAt;
    expect(
      firstCreatedAt !== undefined &&
        secondCreatedAt !== undefined &&
        secondCreatedAt <= firstCreatedAt,
    ).toBe(true);
    expect(secondPage.nextCursor).toBeUndefined();

    const allAudit = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit?limit=100`,
      headers: { cookie: cookieHeader(admin) },
    });
    expect(allAudit.statusCode).toBe(200);
    const allBody = allAudit.json() as {
      items: Array<{ action: string; metadata: Record<string, unknown> }>;
    };
    const updated = allBody.items.find(
      (item) => item.action === "workspace.updated",
    );
    expect(updated).toBeDefined();
    const serialized = JSON.stringify(updated);
    expect(serialized).not.toContain("rb_inv_plaintext-secret");
    expect(serialized).not.toContain("a".repeat(64));
    expect(serialized).not.toContain("session-cookie");
    expect(updated?.metadata["tokenHash"]).toBe("[REDACTED]");
    expect(serialized.length).toBeLessThan(4_000);

    const invalidCursor = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit?cursor=not-a-valid-cursor`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(errorCode(invalidCursor)).toBe("VALIDATION_ERROR");

    const invalidAction = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/audit?action=not-allowlisted`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(invalidAction.statusCode).toBe(400);
    expect(errorCode(invalidAction)).toBe("VALIDATION_ERROR");
  });
});
