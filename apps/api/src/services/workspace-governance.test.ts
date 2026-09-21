import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditRepo, MembershipRepo, type DbClient } from "@replaybug/db";
import { createWorkspace } from "./workspaces.js";
import {
  createTestDbClient,
  createTestUserRow,
  resetTestDatabase,
} from "../test-helpers.js";
import {
  leaveWorkspace,
  listWorkspaceAudit,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
} from "./workspace-governance.js";

describe("workspace governance services", () => {
  let dbClient: DbClient;

  beforeAll(() => {
    dbClient = createTestDbClient();
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await dbClient.close();
  });

  async function setup(): Promise<{
    owner: { id: string; email: string; name: string };
    admin: { id: string; email: string; name: string };
    member: { id: string; email: string; name: string };
    workspaceId: string;
  }> {
    const owner = await createTestUserRow(dbClient, {
      email: `governance-owner-${Date.now()}@example.com`,
      name: "Governance Owner",
    });
    const admin = await createTestUserRow(dbClient, {
      email: `governance-admin-${Date.now()}@example.com`,
      name: "Governance Admin",
    });
    const member = await createTestUserRow(dbClient, {
      email: `governance-member-${Date.now()}@example.com`,
      name: "Governance Member",
    });
    const workspace = await createWorkspace(dbClient.db, owner.id, {
      name: `Governance Service ${Date.now()}`,
    });
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
    });
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId: workspace.id,
      userId: member.id,
      role: "member",
    });
    return { owner, admin, member, workspaceId: workspace.id };
  }

  it("re-reads locked roles before a role mutation and returns a safe member DTO", async () => {
    const { owner, admin, member, workspaceId } = await setup();

    const updated = await updateWorkspaceMemberRole(
      dbClient.db,
      admin.id,
      workspaceId,
      member.id,
      { role: "viewer" },
    );

    expect(updated).toEqual({
      id: member.id,
      name: member.name,
      email: member.email,
      role: "viewer",
    });
    const rows = await dbClient.pool.query<{ role: string }>(
      `SELECT role FROM workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, member.id],
    );
    expect(rows.rows[0]?.role).toBe("viewer");
    expect(owner.id).not.toBe(member.id);
  });

  it("transfers ownership atomically and protects the final owner from leaving", async () => {
    const { owner, member, workspaceId } = await setup();

    await expect(
      leaveWorkspace(dbClient.db, owner.id, workspaceId),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const transfer = await transferWorkspaceOwnership(
      dbClient.db,
      owner.id,
      workspaceId,
      { userId: member.id },
    );
    expect(transfer).toEqual({
      workspaceId,
      previousOwnerId: owner.id,
      newOwnerId: member.id,
    });

    const rows = await dbClient.pool.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM workspace_memberships
       WHERE workspace_id = $1 ORDER BY user_id`,
      [workspaceId],
    );
    expect(rows.rows.filter((row) => row.role === "owner")).toHaveLength(1);
    expect(rows.rows.find((row) => row.user_id === member.id)?.role).toBe(
      "owner",
    );
    expect(rows.rows.find((row) => row.user_id === owner.id)?.role).toBe(
      "admin",
    );
  });

  it("returns sanitized, actor-enriched audit pages with action filtering", async () => {
    const { owner, workspaceId } = await setup();
    await AuditRepo.insertAuditLog(dbClient.db, {
      workspaceId,
      actorUserId: owner.id,
      action: "workspace.updated",
      metadataJson: {
        safe: "visible",
        token: "rb_sk_should-never-appear",
        nested: [{ password: "plain-secret" }],
      },
    });
    await AuditRepo.insertAuditLog(dbClient.db, {
      workspaceId,
      actorUserId: owner.id,
      action: "workspace.updated",
      metadataJson: { safe: "second" },
    });

    const firstPage = await listWorkspaceAudit(
      dbClient.db,
      owner.id,
      workspaceId,
      { action: "workspace.updated", limit: 1 },
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.action).toBe("workspace.updated");
    expect(firstPage.items[0]?.actor).toMatchObject({
      id: owner.id,
      email: owner.email,
      name: owner.name,
    });
    expect(JSON.stringify(firstPage)).not.toContain(
      "rb_sk_should-never-appear",
    );
    expect(JSON.stringify(firstPage)).not.toContain("plain-secret");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = await listWorkspaceAudit(
      dbClient.db,
      owner.id,
      workspaceId,
      {
        action: "workspace.updated",
        limit: 1,
        ...(firstPage.nextCursor === undefined
          ? {}
          : { cursor: firstPage.nextCursor }),
      },
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.nextCursor).toBeUndefined();
  });
});
