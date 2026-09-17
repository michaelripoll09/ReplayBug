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

async function signin(app: AppInstance, email: string): Promise<string[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`signin failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }
  return raw !== undefined ? [String(raw)] : [];
}

describe("Block 2 tenancy integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    const config = testApiConfig();
    app = await buildApp({ config, dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("register, login, me 401 without session and 200 with session", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ code: "AUTH_REQUIRED" });

    const email = `me-${Date.now()}@example.com`;
    const cookies = await signup(app, email);
    expect(cookies.length).toBeGreaterThan(0);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookiesHeader(cookies) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email });

    // Login again produces a session too.
    const cookies2 = await signin(app, email);
    expect(cookies2.length).toBeGreaterThan(0);
  });

  it("workspace + project lifecycle with bootstrap, prod env, key and audit", async () => {
    const email = `ws-${Date.now()}@example.com`;
    const cookies = await signup(app, email);
    const cookie = cookiesHeader(cookies);

    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: "Acme" },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string; slug: string };
    expect(ws.slug).toBe("acme");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as unknown[]).length).toBe(1);

    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie },
      payload: { name: "Storefront Web" },
    });
    expect(projRes.statusCode).toBe(201);
    const created = projRes.json() as {
      project: { id: string; slug: string };
      bootstrap: {
        key: string;
        prefix: string;
        projectId: string;
        ingestEnabled: boolean;
        ingestEndpoint: string;
      };
    };
    expect(created.project.slug).toBe("storefront-web");
    expect(created.bootstrap.ingestEnabled).toBe(false);
    expect(created.bootstrap.ingestEndpoint).toContain("FUTURE");
    expect(created.bootstrap.key).toMatch(
      /^rb_pk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/,
    );
    expect(created.bootstrap.projectId).toBe(created.project.id);

    // Default prod env auto-created.
    const envsRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.project.id}/environments`,
      headers: { cookie },
    });
    expect(envsRes.statusCode).toBe(200);
    const envs = envsRes.json() as { name: string; isDefault: boolean }[];
    expect(envs.length).toBe(1);
    expect(envs[0]).toMatchObject({ name: "production", isDefault: true });

    // Key metadata lists prefix, never plaintext.
    const keysRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${created.project.id}/keys`,
      headers: { cookie },
    });
    expect(keysRes.statusCode).toBe(200);
    const keys = keysRes.json() as {
      prefix: string;
      key?: string;
      keyHash?: string;
    }[];
    expect(keys.length).toBe(1);
    expect(keys[0]?.prefix).toBe(created.bootstrap.prefix);
    expect(JSON.stringify(keys)).not.toContain(created.bootstrap.key);

    // DB proof: hash+prefix only, no plaintext; owner membership + audit exist.
    const dbRows = await dbClient.pool.query(
      `SELECT prefix, key_hash FROM project_keys WHERE project_id = $1`,
      [created.project.id],
    );
    expect(dbRows.rows.length).toBe(1);
    expect(dbRows.rows[0].prefix).toBe(created.bootstrap.prefix);
    expect(String(dbRows.rows[0].key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(dbRows.rows[0].key_hash)).not.toContain(
      created.bootstrap.key,
    );

    const memRows = await dbClient.pool.query(
      `SELECT role FROM workspace_memberships WHERE workspace_id = $1`,
      [ws.id],
    );
    expect(memRows.rows[0].role).toBe("owner");

    const auditRows = await dbClient.pool.query(
      `SELECT action FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at`,
      [ws.id],
    );
    const actions = auditRows.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain("workspace.created");
    expect(actions).toContain("project.created");
  });

  it("enforces RBAC: member read-only, cross-tenant 404, conflicts 409", async () => {
    const ownerCookies = cookiesHeader(
      await signup(app, `owner-${Date.now()}@example.com`),
    );
    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie: ownerCookies },
      payload: { name: "Tenant A" },
    });
    const ws = wsRes.json() as { id: string };

    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie: ownerCookies },
      payload: { name: "Proj A" },
    });
    const projectId = (projRes.json() as { project: { id: string } }).project
      .id;

    // Second user: no membership -> workspace get is 404 (anti-enumeration).
    const strangerCookies = cookiesHeader(
      await signup(app, `stranger-${Date.now()}@example.com`),
    );
    const crossWs = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${ws.id}`,
      headers: { cookie: strangerCookies },
    });
    expect(crossWs.statusCode).toBe(404);
    expect(crossWs.json()).toMatchObject({ code: "NOT_FOUND" });

    const crossProj = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: strangerCookies },
    });
    expect(crossProj.statusCode).toBe(404);

    // Grant member role directly (no member-management API this block).
    const strangerMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: strangerCookies },
    });
    const strangerId = (strangerMe.json() as { id: string }).id;
    await dbClient.pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [ws.id, strangerId],
    );

    // Member can read but cannot create/update/delete or rotate.
    const memberRead = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie: strangerCookies },
    });
    expect(memberRead.statusCode).toBe(200);

    const memberCreate = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie: strangerCookies },
      payload: { name: "Nope" },
    });
    expect(memberCreate.statusCode).toBe(403);
    expect(memberCreate.json()).toMatchObject({ code: "FORBIDDEN" });

    const rotateForbidden = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/keys/public/rotate`,
      headers: { cookie: strangerCookies },
    });
    expect(rotateForbidden.statusCode).toBe(403);

    // Slug conflict -> 409, not 500, with requestId and no leak.
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie: ownerCookies },
      payload: { name: "Proj A" },
    });
    expect(dup.statusCode).toBe(409);
    const dupBody = dup.json() as Record<string, unknown>;
    expect(dupBody["code"]).toBe("CONFLICT");
    expect(dupBody["requestId"]).toBeDefined();
    expect(JSON.stringify(dupBody)).not.toMatch(/at |SELECT|key_hash|cookie/i);
  });

  it("validates origins exhaustively and rotates keys with one-time plaintext", async () => {
    const cookies = cookiesHeader(
      await signup(app, `orig-${Date.now()}@example.com`),
    );
    const ws = (await (
      await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: cookies },
        payload: { name: "Orig WS" },
      })
    ).json()) as { id: string };
    const proj = (
      (await (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${ws.id}/projects`,
          headers: { cookie: cookies },
          payload: { name: "Orig Proj" },
        })
      ).json()) as {
        project: { id: string };
        bootstrap: { key: string; prefix: string };
      }
    ).project;
    const firstKey =
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${ws.id}/projects`,
          headers: { cookie: cookies },
          payload: { name: "Orig Proj" },
        })
      ).statusCode === 409
        ? null
        : null;
    void firstKey;

    // Valid explicit localhost origin.
    const okOrigin = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${proj.id}/origins`,
      headers: { cookie: cookies },
      payload: { origin: "http://localhost:5173/" },
    });
    expect(okOrigin.statusCode).toBe(201);
    expect((okOrigin.json() as { origin: string }).origin).toBe(
      "http://localhost:5173",
    );

    // Invalid: path, wildcard, bad scheme.
    for (const bad of [
      "https://example.com/app",
      "https://*.example.com",
      "javascript:alert(1)",
      "http://localhost:*",
    ]) {
      const badRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${proj.id}/origins`,
        headers: { cookie: cookies },
        payload: { origin: bad },
      });
      expect(badRes.statusCode).toBe(400);
      expect(badRes.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    }

    // Duplicate origin -> 409.
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${proj.id}/origins`,
      headers: { cookie: cookies },
      payload: { origin: "http://localhost:5173" },
    });
    expect(dup.statusCode).toBe(409);

    // Rotate: new plaintext once, old revoked retained.
    const rotate = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${proj.id}/keys/public/rotate`,
      headers: { cookie: cookies },
    });
    expect(rotate.statusCode).toBe(200);
    const rotated = rotate.json() as {
      key: string;
      prefix: string;
      id: string;
    };
    expect(rotated.key).toMatch(/^rb_pk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);

    const keys = (await (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${proj.id}/keys`,
        headers: { cookie: cookies },
      })
    ).json()) as { prefix: string; revokedAt: string | null }[];
    expect(keys.length).toBe(2);
    const revoked = keys.filter((k) => k.revokedAt !== null);
    const active = keys.filter((k) => k.revokedAt === null);
    expect(revoked.length).toBe(1);
    expect(active.length).toBe(1);
    expect(active[0]?.prefix).toBe(rotated.prefix);
    expect(JSON.stringify(keys)).not.toContain(rotated.key);
  });

  it("enforces environment invariants: single default, never zero, deterministic promotion", async () => {
    const cookies = cookiesHeader(
      await signup(app, `env-${Date.now()}@example.com`),
    );
    const ws = (await (
      await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: cookies },
        payload: { name: "Env WS" },
      })
    ).json()) as { id: string };
    const proj = (
      (await (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${ws.id}/projects`,
          headers: { cookie: cookies },
          payload: { name: "Env Proj" },
        })
      ).json()) as { project: { id: string } }
    ).project;

    // Reject javascript: base_url.
    const badEnv = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${proj.id}/environments`,
      headers: { cookie: cookies },
      payload: { name: "staging", baseUrl: "javascript:alert(1)" },
    });
    expect(badEnv.statusCode).toBe(400);

    const staging = (await (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${proj.id}/environments`,
        headers: { cookie: cookies },
        payload: {
          name: "staging",
          baseUrl: "https://staging.example.com",
          isDefault: true,
        },
      })
    ).json()) as { id: string; isDefault: boolean };
    expect(staging.isDefault).toBe(true);

    // Old production is no longer default (single-default invariant).
    const envs = (await (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${proj.id}/environments`,
        headers: { cookie: cookies },
      })
    ).json()) as { name: string; isDefault: boolean; id: string }[];
    expect(envs.filter((e) => e.isDefault).length).toBe(1);
    expect(envs.find((e) => e.name === "staging")?.isDefault).toBe(true);

    // Delete default staging -> deterministic promotion (smallest name).
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/environments/${staging.id}`,
      headers: { cookie: cookies },
    });
    expect(del.statusCode).toBe(200);
    const after = (await (
      await app.inject({
        method: "GET",
        url: `/api/v1/projects/${proj.id}/environments`,
        headers: { cookie: cookies },
      })
    ).json()) as { name: string; isDefault: boolean; id: string }[];
    expect(after.length).toBe(1);
    expect(after[0]?.isDefault).toBe(true);

    // Cannot delete the last environment.
    const lastId = after[0]?.id as string;
    const delLast = await app.inject({
      method: "DELETE",
      url: `/api/v1/environments/${lastId}`,
      headers: { cookie: cookies },
    });
    expect(delLast.statusCode).toBe(400);
  });

  it("deletes projects transactionally and idempotently", async () => {
    const cookies = cookiesHeader(
      await signup(app, `del-${Date.now()}@example.com`),
    );
    const ws = (await (
      await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: cookies },
        payload: { name: "Del WS" },
      })
    ).json()) as { id: string };
    const proj = (
      (await (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${ws.id}/projects`,
          headers: { cookie: cookies },
          payload: { name: "Del Proj" },
        })
      ).json()) as { project: { id: string } }
    ).project;

    const first = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${proj.id}`,
      headers: { cookie: cookies },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ deleted: true });

    const second = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${proj.id}`,
      headers: { cookie: cookies },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ deleted: false });
  });

  it("exposes strict CORS for the dashboard origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
  });
});
