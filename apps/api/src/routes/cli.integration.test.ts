import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateSecretToken } from "@replaybug/db";
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
): Promise<{
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  bootstrapKey: string;
}> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: workspaceName },
  });
  expect(wsRes.statusCode).toBe(201);
  const ws = wsRes.json() as { id: string; name: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: projectName },
  });
  expect(projRes.statusCode).toBe(201);
  const created = projRes.json() as {
    project: { id: string; name: string; slug: string };
    bootstrap: { key: string };
  };
  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    projectId: created.project.id,
    projectName: created.project.name,
    projectSlug: created.project.slug,
    bootstrapKey: created.bootstrap.key,
  };
}

async function createSecretToken(
  app: AppInstance,
  cookie: string,
  projectId: string,
  name = "ci-token",
): Promise<{ id: string; token: string; prefix: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/secret-tokens`,
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; prefix: string };
}

async function lastUsedAt(
  dbClient: DbClient,
  tokenId: string,
): Promise<string | null> {
  const rows = await dbClient.pool.query(
    `SELECT last_used_at FROM project_keys WHERE id = $1`,
    [tokenId],
  );
  const value = (rows.rows[0] as { last_used_at: Date | null }).last_used_at;
  return value === null ? null : value.toISOString();
}

describe("RS-03 CLI auth boundary (real PG)", () => {
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

  it("valid token returns only the owning project info", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-valid-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "CLI WS",
      "CLI Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      projectSlug: fixture.projectSlug,
      workspaceId: fixture.workspaceId,
      workspaceName: fixture.workspaceName,
    });
    // Minimal envelope: no key material, no membership, no extra projects.
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(
      [
        "projectId",
        "projectName",
        "projectSlug",
        "timezone",
        "workspaceId",
        "workspaceName",
      ].sort(),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain(created.prefix);
    expect(serialized).not.toMatch(/keyHash|key_hash|revoked|member|email/i);
  });

  it("missing Authorization header is 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/cli/project" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("wrong auth scheme is 401", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-scheme-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Scheme WS",
      "Scheme Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);
    const candidates = [
      `Basic ${created.token}`,
      `Token ${created.token}`,
      `bearer ${created.token}`,
      `Bearer`,
      `Bearer `,
    ];
    for (const header of candidates) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/cli/project",
        headers: { authorization: header },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });

  it("malformed tokens are 401", async () => {
    const malformed = [
      "garbage",
      "",
      "rb_sk_short",
      "rb_sk_zzzzzzzz_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "rb_pk_12345678_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];
    for (const token of malformed) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/cli/project",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });

  it("wrong secret with the same prefix is 401 and does not touch last_used_at", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-prefix-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Prefix WS",
      "Prefix Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);
    const other = generateSecretToken();
    const forged = `rb_sk_${created.prefix}_${other.fullToken.split("_")[2] ?? ""}`;
    expect(forged).not.toBe(created.token);

    const before = await lastUsedAt(dbClient, created.id);
    expect(before).toBeNull();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);

    expect(await lastUsedAt(dbClient, created.id)).toBeNull();
  });

  it("revoked tokens are 401", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-revoked-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Revoked WS",
      "Revoked Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/secret-tokens/${created.id}/revoke`,
      headers: { cookie: cookies },
    });
    expect(revoke.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("public ingest keys are denied on CLI routes", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-public-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Public WS",
      "Public Proj",
    );
    expect(fixture.bootstrapKey).toMatch(/^rb_pk_/);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${fixture.bootstrapKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("session cookie without a token is denied", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-cookie-${Date.now()}@example.com`),
    );
    await createWorkspaceAndProject(app, cookies, "Cookie WS", "Cookie Proj");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("credentials in the query string never authenticate", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-query-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Query WS",
      "Query Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);
    const encoded = encodeURIComponent(created.token);
    for (const url of [
      `/api/v1/cli/project?token=${encoded}`,
      `/api/v1/cli/project?api_token=${encoded}`,
      `/api/v1/cli/project?access_token=${encoded}`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
    expect(await lastUsedAt(dbClient, created.id)).toBeNull();
  });

  it("project scoping is inherent: token A resolves only project A", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-scope-${Date.now()}@example.com`),
    );
    const projectA = await createWorkspaceAndProject(
      app,
      cookies,
      "Scope WS A",
      "Scope Proj A",
    );
    const projectB = await createWorkspaceAndProject(
      app,
      cookies,
      "Scope WS B",
      "Scope Proj B",
    );
    const tokenA = await createSecretToken(
      app,
      cookies,
      projectA.projectId,
      "a",
    );
    const tokenB = await createSecretToken(
      app,
      cookies,
      projectB.projectId,
      "b",
    );

    const resA = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${tokenA.token}` },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json() as {
      projectId: string;
      projectSlug: string;
      workspaceId: string;
    };
    expect(bodyA.projectId).toBe(projectA.projectId);
    expect(bodyA.projectId).not.toBe(projectB.projectId);
    expect(JSON.stringify(bodyA)).not.toContain(projectB.projectId);
    expect(JSON.stringify(bodyA)).not.toContain(projectB.projectSlug);

    const resB = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${tokenB.token}` },
    });
    expect(resB.statusCode).toBe(200);
    expect((resB.json() as { projectId: string }).projectId).toBe(
      projectB.projectId,
    );
  });

  it("last_used_at updates on success and stays put on failure", async () => {
    const cookies = cookiesHeader(
      await signup(app, `cli-touch-${Date.now()}@example.com`),
    );
    const fixture = await createWorkspaceAndProject(
      app,
      cookies,
      "Touch WS",
      "Touch Proj",
    );
    const created = await createSecretToken(app, cookies, fixture.projectId);
    expect(await lastUsedAt(dbClient, created.id)).toBeNull();

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(ok.statusCode).toBe(200);
    const touched = await lastUsedAt(dbClient, created.id);
    expect(touched).not.toBeNull();

    const other = generateSecretToken();
    const forged = `rb_sk_${created.prefix}_${other.fullToken.split("_")[2] ?? ""}`;
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/cli/project",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(denied.statusCode).toBe(401);
    expect(await lastUsedAt(dbClient, created.id)).toBe(touched);
  });
});
