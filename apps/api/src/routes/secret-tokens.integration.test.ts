import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import type { DbClient } from "@replaybug/db";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

async function signup(app: AppInstance, email: string): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }
  return raw !== undefined ? [String(raw)] : [];
}

async function createWorkspaceAndProject(
  app: AppInstance,
  cookie: string,
  workspaceName: string,
  projectName: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: workspaceName },
  });
  expect(wsRes.statusCode).toBe(201);
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: projectName },
  });
  expect(projRes.statusCode).toBe(201);
  const created = projRes.json() as { project: { id: string } };
  return { workspaceId: ws.id, projectId: created.project.id };
}

interface SecretTokenMeta {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

describe("RS-02 secret-token management API (real PG)", () => {
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

  it("owner can create a token returned once; list never leaks secrets", async () => {
    const cookies = cookiesHeader(
      await signup(app, `sectok-owner-${Date.now()}@example.com`),
    );
    const { projectId } = await createWorkspaceAndProject(
      app,
      cookies,
      "Secret WS",
      "Secret Proj",
    );

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/secret-tokens`,
      headers: { cookie: cookies },
      payload: { name: "ci-upload" },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as SecretTokenMeta & { token: string };
    expect(created.token).toMatch(/^rb_sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(created.token).toContain(created.prefix);
    expect(created.name).toBe("ci-upload");
    expect(created.kind).toBe("secret");

    // List: metadata only, never the full token or hash.
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/secret-tokens`,
      headers: { cookie: cookies },
    });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json() as SecretTokenMeta[];
    expect(items.length).toBe(1);
    const item = items[0] as SecretTokenMeta;
    expect(item?.id).toBe(created.id);
    expect(item?.prefix).toBe(created.prefix);
    expect(item?.lastUsedAt).toBeNull();
    expect(item?.revokedAt).toBeNull();
    expect(JSON.stringify(items)).not.toContain(created.token);
    expect(JSON.stringify(items)).not.toMatch(/key_hash|keyHash/);

    // DB proof: hash+prefix only, plaintext absent.
    const dbRows = await dbClient.pool.query(
      `SELECT prefix, key_hash, kind FROM project_keys WHERE id = $1`,
      [created.id],
    );
    expect(dbRows.rows[0].kind).toBe("secret");
    expect(dbRows.rows[0].prefix).toBe(created.prefix);
    expect(String(dbRows.rows[0].key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dbRows.rows[0])).not.toContain(created.token);
  });

  it("validates token names: blank, overlong and control-char names are rejected", async () => {
    const cookies = cookiesHeader(
      await signup(app, `sectok-name-${Date.now()}@example.com`),
    );
    const { projectId } = await createWorkspaceAndProject(
      app,
      cookies,
      "Name WS",
      "Name Proj",
    );
    const invalidNames: string[] = [
      "",
      "   ",
      "x".repeat(101),
      `bad${String.fromCharCode(0)}name`,
    ];
    for (const bad of invalidNames) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/secret-tokens`,
        headers: { cookie: cookies },
        payload: { name: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("enforces RBAC: member/viewer cannot create, owner/admin can create and revoke", async () => {
    const ownerCookies = cookiesHeader(
      await signup(app, `sectok-rbaco-${Date.now()}@example.com`),
    );
    const { workspaceId, projectId } = await createWorkspaceAndProject(
      app,
      ownerCookies,
      "RBAC WS",
      "RBAC Proj",
    );

    const memberEmail = `sectok-m-${Date.now()}@example.com`;
    const memberCookies = cookiesHeader(await signup(app, memberEmail));
    const memberMe = (await (
      await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie: memberCookies },
      })
    ).json()) as { id: string };
    await dbClient.pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, memberMe.id],
    );

    const viewerEmail = `sectok-v-${Date.now()}@example.com`;
    const viewerCookies = cookiesHeader(await signup(app, viewerEmail));
    const viewerMe = (await (
      await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie: viewerCookies },
      })
    ).json()) as { id: string };
    await dbClient.pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`,
      [workspaceId, viewerMe.id],
    );

    for (const cookies of [memberCookies, viewerCookies]) {
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/secret-tokens`,
        headers: { cookie: cookies },
        payload: { name: "nope" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    }

    // Promote the member to admin: creation is then allowed.
    await dbClient.pool.query(
      `UPDATE workspace_memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, memberMe.id],
    );
    const adminCreate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/secret-tokens`,
      headers: { cookie: memberCookies },
      payload: { name: "admin-token" },
    });
    expect(adminCreate.statusCode).toBe(201);

    // Owner revokes the admin-created token; a second revoke conflicts.
    const tokenId = (adminCreate.json() as { id: string }).id;
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/secret-tokens/${tokenId}/revoke`,
      headers: { cookie: ownerCookies },
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      (revoke.json() as { revokedAt: string | null }).revokedAt,
    ).not.toBeNull();

    const revokeAgain = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/secret-tokens/${tokenId}/revoke`,
      headers: { cookie: ownerCookies },
    });
    expect(revokeAgain.statusCode).toBe(409);
  });

  it("revocation is project-scoped and audited without plaintext or hash", async () => {
    const cookies = cookiesHeader(
      await signup(app, `sectok-audit-${Date.now()}@example.com`),
    );
    const first = await createWorkspaceAndProject(
      app,
      cookies,
      "Audit WS",
      "Audit Proj",
    );
    const second = await createWorkspaceAndProject(
      app,
      cookies,
      "Audit WS 2",
      "Audit Proj 2",
    );

    const created = (await (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${first.projectId}/secret-tokens`,
        headers: { cookie: cookies },
        payload: { name: "audited" },
      })
    ).json()) as { id: string; token: string; prefix: string };

    // Cross-project revoke must not reveal existence.
    const cross = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${second.projectId}/secret-tokens/${created.id}/revoke`,
      headers: { cookie: cookies },
    });
    expect(cross.statusCode).toBe(404);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${first.projectId}/secret-tokens/${created.id}/revoke`,
      headers: { cookie: cookies },
    });
    expect(revoke.statusCode).toBe(200);

    const auditRows = await dbClient.pool.query(
      `SELECT action, metadata_json FROM audit_logs WHERE project_id = $1 ORDER BY created_at`,
      [first.projectId],
    );
    const actions = auditRows.rows.map((r: { action: string }) => r.action);
    expect(actions.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(auditRows.rows);
    expect(serialized).not.toContain(created.token);
    // No hash material may reach the audit trail.
    const hashes = await dbClient.pool.query(
      `SELECT key_hash FROM project_keys WHERE id = $1`,
      [created.id],
    );
    const storedHash = String(
      (hashes.rows[0] as { key_hash: string }).key_hash,
    );
    expect(serialized).not.toContain(storedHash);
  });
});
