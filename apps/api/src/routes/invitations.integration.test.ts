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

type SignedInUser = { cookies: string[]; userId: string; email: string };

type InvitationResponse = {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  tokenPrefix: string;
  status: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  token: string;
  inviteUrl: string;
  deliveryNote: string;
};

async function signup(app: AppInstance, email: string): Promise<SignedInUser> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Invitation Tester" },
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
  return { cookies, userId: body.id, email };
}

async function createWorkspace(
  app: AppInstance,
  cookies: string[],
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie: cookiesHeader(cookies) },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

function cookieHeader(user: SignedInUser): string {
  return cookiesHeader(user.cookies);
}

async function createInvitation(
  app: AppInstance,
  workspaceId: string,
  owner: SignedInUser,
  email: string,
  role: string,
): Promise<{ response: InvitationResponse; statusCode: number }> {
  const result = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/invitations`,
    headers: { cookie: cookieHeader(owner) },
    payload: { email, role },
  });
  return {
    response: result.json() as InvitationResponse,
    statusCode: result.statusCode,
  };
}

describe("workspace invitations integration (real PG)", () => {
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

  it("creates hash-only one-time links and lists safe metadata", async () => {
    const owner = await signup(app, `owner-create-${Date.now()}@example.com`);
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Create ${Date.now()}`,
    );
    const email = `  Invitee-${Date.now()}@Example.COM `;
    const anonymousList = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
    });
    expect(anonymousList.statusCode).toBe(401);
    const created = await createInvitation(
      app,
      workspaceId,
      owner,
      email,
      "member",
    );

    expect(created.statusCode).toBe(201);
    expect(created.response.email).toBe(email.trim().toLowerCase());
    expect(created.response.token).toMatch(
      /^rb_inv_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/,
    );
    expect(created.response.inviteUrl).toContain(created.response.token);
    expect(created.response.deliveryNote).toContain("Email delivery");
    expect(created.response.status).toBe("pending");
    expect(JSON.stringify(created.response)).toContain(created.response.token);

    const rows = await dbClient.pool.query(
      `SELECT row_to_json(t) AS row
         FROM workspace_invitations t
        WHERE id = $1`,
      [created.response.id],
    );
    expect(rows.rows).toHaveLength(1);
    const persisted = JSON.stringify(rows.rows[0]);
    expect(persisted).not.toContain(created.response.token);
    const hashRows = await dbClient.pool.query(
      `SELECT token_hash, token_prefix, email, role
         FROM workspace_invitations
        WHERE id = $1`,
      [created.response.id],
    );
    expect(String(hashRows.rows[0]?.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(hashRows.rows[0]?.token_hash)).not.toBe(
      created.response.token,
    );
    expect(hashRows.rows[0]?.token_prefix).toBe(created.response.tokenPrefix);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.["status"]).toBe("pending");
    expect(JSON.stringify(items)).not.toContain(created.response.token);
    expect(items[0]?.["tokenHash"]).toBeUndefined();
    expect(items[0]?.["inviteUrl"]).toBeUndefined();

    const audits = await dbClient.pool.query(
      `SELECT action, metadata_json FROM audit_logs WHERE workspace_id = $1`,
      [workspaceId],
    );
    const invitationAudit = audits.rows.find(
      (row: { action: string }) =>
        row.action === "workspace_invitation.created",
    ) as { metadata_json: unknown } | undefined;
    expect(invitationAudit).toBeDefined();
    expect(JSON.stringify(invitationAudit?.metadata_json)).not.toContain(
      created.response.token,
    );
    expect(JSON.stringify(invitationAudit?.metadata_json)).not.toMatch(
      /token_hash|inviteUrl|cookie/i,
    );
  });

  it("enforces the owner/admin role matrix and rejects lower roles", async () => {
    const owner = await signup(app, `owner-roles-${Date.now()}@example.com`);
    const admin = await signup(app, `admin-roles-${Date.now()}@example.com`);
    const member = await signup(app, `member-roles-${Date.now()}@example.com`);
    const viewer = await signup(app, `viewer-roles-${Date.now()}@example.com`);
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Roles ${Date.now()}`,
    );
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId,
      userId: admin.userId,
      role: "admin",
    });
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

    for (const role of ["admin", "member", "viewer"] as const) {
      const result = await createInvitation(
        app,
        workspaceId,
        owner,
        `owner-${role}-${Date.now()}@example.com`,
        role,
      );
      expect(result.statusCode).toBe(201);
    }

    for (const role of ["member", "viewer"] as const) {
      const result = await createInvitation(
        app,
        workspaceId,
        admin,
        `admin-${role}-${Date.now()}@example.com`,
        role,
      );
      expect(result.statusCode).toBe(201);
    }
    const adminOwnerRole = await createInvitation(
      app,
      workspaceId,
      admin,
      `admin-owner-${Date.now()}@example.com`,
      "admin",
    );
    expect(adminOwnerRole.statusCode).toBe(403);
    expect(adminOwnerRole.response).toMatchObject({ code: "FORBIDDEN" });

    for (const lower of [member, viewer]) {
      const result = await createInvitation(
        app,
        workspaceId,
        lower,
        `lower-${Date.now()}@example.com`,
        "viewer",
      );
      expect(result.statusCode).toBe(403);
      expect(result.response).toMatchObject({ code: "FORBIDDEN" });
    }

    const ownerRole = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
      payload: {
        email: `owner-role-${Date.now()}@example.com`,
        role: "owner",
      },
    });
    expect(ownerRole.statusCode).toBe(400);
    expect(ownerRole.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns safe duplicate/member/cross-tenant conflicts", async () => {
    const owner = await signup(app, `owner-conflict-${Date.now()}@example.com`);
    const otherOwner = await signup(
      app,
      `other-owner-conflict-${Date.now()}@example.com`,
    );
    const existingMember = await signup(
      app,
      `existing-member-${Date.now()}@example.com`,
    );
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Conflicts ${Date.now()}`,
    );
    const otherWorkspaceId = await createWorkspace(
      app,
      otherOwner.cookies,
      `Other Invite Conflicts ${Date.now()}`,
    );
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId,
      userId: existingMember.userId,
      role: "member",
    });

    const active = await createInvitation(
      app,
      workspaceId,
      owner,
      `duplicate-${Date.now()}@example.com`,
      "viewer",
    );
    expect(active.statusCode).toBe(201);
    const duplicate = await createInvitation(
      app,
      workspaceId,
      owner,
      active.response.email,
      "member",
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.response).toMatchObject({
      code: "ACTIVE_INVITATION_EXISTS",
    });
    expect(JSON.stringify(duplicate.response)).not.toContain(
      active.response.token,
    );

    const memberResult = await createInvitation(
      app,
      workspaceId,
      owner,
      existingMember.email,
      "viewer",
    );
    expect(memberResult.statusCode).toBe(409);
    expect(memberResult.response).toMatchObject({
      code: "ALREADY_WORKSPACE_MEMBER",
    });

    const crossCreate = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${otherWorkspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
      payload: { email: `cross-${Date.now()}@example.com`, role: "viewer" },
    });
    expect(crossCreate.statusCode).toBe(404);
    expect(crossCreate.json()).toMatchObject({ code: "NOT_FOUND" });

    const crossList = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${otherWorkspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(crossList.statusCode).toBe(404);
  });

  it("binds acceptance to email, expires safely, and permits reissue", async () => {
    const owner = await signup(app, `owner-accept-${Date.now()}@example.com`);
    const invitee = await signup(
      app,
      `invitee-accept-${Date.now()}@example.com`,
    );
    const wrongUser = await signup(
      app,
      `wrong-accept-${Date.now()}@example.com`,
    );
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Accept ${Date.now()}`,
    );
    const created = await createInvitation(
      app,
      workspaceId,
      owner,
      invitee.email,
      "member",
    );
    expect(created.statusCode).toBe(201);

    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/invitations/${created.response.token}/accept`,
      headers: { cookie: cookieHeader(wrongUser) },
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toMatchObject({ code: "INVITATION_INVALID" });
    expect(wrong.body).not.toContain(created.response.token);

    const expiredCreated = await createInvitation(
      app,
      workspaceId,
      owner,
      `expired-${Date.now()}@example.com`,
      "viewer",
    );
    await dbClient.pool.query(
      `UPDATE workspace_invitations
          SET created_at = now() - interval '2 minutes',
              expires_at = now() - interval '1 minute'
        WHERE id = $1`,
      [expiredCreated.response.id],
    );
    const expiredAccept = await app.inject({
      method: "POST",
      url: `/api/v1/invitations/${expiredCreated.response.token}/accept`,
      headers: { cookie: cookieHeader(invitee) },
    });
    expect(expiredAccept.statusCode).toBe(404);
    expect(expiredAccept.json()).toMatchObject({ code: "INVITATION_INVALID" });

    const expiredList = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
    });
    const beforeReissue = expiredList.json() as Array<{
      id: string;
      status: string;
    }>;
    expect(
      beforeReissue.find((item) => item.id === expiredCreated.response.id)
        ?.status,
    ).toBe("expired");

    const reissued = await createInvitation(
      app,
      workspaceId,
      owner,
      expiredCreated.response.email,
      "viewer",
    );
    expect(reissued.statusCode).toBe(201);
    expect(reissued.response.token).not.toBe(expiredCreated.response.token);

    const afterReissue = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
    });
    const afterItems = afterReissue.json() as Array<{
      id: string;
      status: string;
    }>;
    expect(
      afterItems.find((item) => item.id === expiredCreated.response.id)?.status,
    ).toBe("expired");
    expect(
      afterItems.find((item) => item.id === reissued.response.id)?.status,
    ).toBe("pending");

    const valid = await app.inject({
      method: "POST",
      url: `/api/v1/invitations/${created.response.token}/accept`,
      headers: { cookie: cookieHeader(invitee) },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({
      invitationId: created.response.id,
      workspaceId,
      role: "member",
    });
    const acceptedList = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/invitations`,
      headers: { cookie: cookieHeader(owner) },
    });
    const acceptedItem = (
      acceptedList.json() as Array<{ id: string; status: string }>
    ).find((item) => item.id === created.response.id);
    expect(acceptedItem?.status).toBe("accepted");
    const acceptedRevoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/invitations/${created.response.id}`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(acceptedRevoke.statusCode).toBe(409);
  });

  it("revokes idempotently and audits only the first state change", async () => {
    const owner = await signup(app, `owner-revoke-${Date.now()}@example.com`);
    const invitee = await signup(
      app,
      `invitee-revoke-${Date.now()}@example.com`,
    );
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Revoke ${Date.now()}`,
    );
    const created = await createInvitation(
      app,
      workspaceId,
      owner,
      `invitee-revoke-${Date.now()}@example.com`,
      "viewer",
    );

    const first = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/invitations/${created.response.id}`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status: string }).status).toBe("revoked");
    const second = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/invitations/${created.response.id}`,
      headers: { cookie: cookieHeader(owner) },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { status: string }).status).toBe("revoked");

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/invitations/${created.response.token}/accept`,
      headers: { cookie: cookieHeader(invitee) },
    });
    expect(accepted.statusCode).toBe(404);
    expect(accepted.json()).toMatchObject({ code: "INVITATION_INVALID" });

    const audits = await dbClient.pool.query(
      `SELECT action FROM audit_logs
        WHERE workspace_id = $1 AND action = 'workspace_invitation.revoked'`,
      [workspaceId],
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("accepts one time under concurrent requests and leaves one membership", async () => {
    const owner = await signup(
      app,
      `owner-concurrent-${Date.now()}@example.com`,
    );
    const inviteeEmail = `invitee-concurrent-${Date.now()}@example.com`;
    const invitee = await signup(app, inviteeEmail);
    const workspaceId = await createWorkspace(
      app,
      owner.cookies,
      `Invite Concurrent ${Date.now()}`,
    );
    const created = await createInvitation(
      app,
      workspaceId,
      owner,
      inviteeEmail,
      "member",
    );

    const results = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/invitations/${created.response.token}/accept`,
        headers: { cookie: cookieHeader(invitee) },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/invitations/${created.response.token}/accept`,
        headers: { cookie: cookieHeader(invitee) },
      }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const conflictResult = results.find((result) => result.statusCode === 409);
    expect(conflictResult?.json()).toMatchObject({
      code: "INVITATION_ALREADY_USED",
    });

    const memberships = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count
         FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, invitee.userId],
    );
    expect(memberships.rows[0]?.count).toBe(1);
    const audits = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count
         FROM audit_logs
        WHERE workspace_id = $1 AND action = 'workspace_invitation.accepted'`,
      [workspaceId],
    );
    expect(audits.rows[0]?.count).toBe(1);
  });
});
