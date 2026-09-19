import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReleaseRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

async function signup(app: AppInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? raw
    : raw !== undefined
      ? [String(raw)]
      : [];
  return cookiesHeader(cookies as string[]);
}

async function createWorkspaceAndProject(
  app: AppInstance,
  cookie: string,
  workspaceName: string,
  projectName: string,
): Promise<{ projectId: string; bootstrapKey: string }> {
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
  const created = projRes.json() as {
    project: { id: string };
    bootstrap: { key: string };
  };
  return {
    projectId: created.project.id,
    bootstrapKey: created.bootstrap.key,
  };
}

async function createSecretToken(
  app: AppInstance,
  cookie: string,
  projectId: string,
  name = "ci-token",
): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/secret-tokens`,
    headers: { cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

interface ReleaseBody {
  id: string;
  version: string;
  commit: string | null;
  repositoryUrl: string | null;
  createdAt: string;
}

describe("RS-04 CLI releases (real PG)", () => {
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

  async function fixture(name: string): Promise<{
    cookie: string;
    projectId: string;
    bootstrapKey: string;
    token: string;
    tokenId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cookie = await signup(app, `rel-${name}-${stamp}@example.com`);
    const { projectId, bootstrapKey } = await createWorkspaceAndProject(
      app,
      cookie,
      `Rel WS ${name} ${stamp}`,
      `Rel Proj ${name} ${stamp}`,
    );
    const secret = await createSecretToken(app, cookie, projectId, name);
    return {
      cookie,
      projectId,
      bootstrapKey,
      token: secret.token,
      tokenId: secret.id,
    };
  }

  it("creates a release with 201 and a created envelope", async () => {
    const f = await fixture("create");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload: {
        version: "web@1.4.2",
        commitSha: "abc1234",
        repositoryUrl: "https://github.com/acme/app",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { release: ReleaseBody; created: boolean };
    expect(body.created).toBe(true);
    expect(body.release.version).toBe("web@1.4.2");
    expect(body.release.commit).toBe("abc1234");
    expect(body.release.repositoryUrl).toBe("https://github.com/acme/app");
    expect(typeof body.release.id).toBe("string");
    expect(typeof body.release.createdAt).toBe("string");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(f.token);
    expect(serialized).not.toMatch(/keyHash|key_hash|storageKey|secret/i);
  });

  it("re-creates the identical release with 200 already-exists", async () => {
    const f = await fixture("idempotent");
    const payload = {
      version: "demo@2026.09.18",
      commitSha: "a".repeat(40),
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    const firstBody = first.json() as {
      release: ReleaseBody;
      created: boolean;
    };
    const secondBody = second.json() as {
      release: ReleaseBody;
      created: boolean;
    };
    expect(secondBody.created).toBe(false);
    expect(secondBody.release.id).toBe(firstBody.release.id);
  });

  it("returns 409 RELEASE_VERSION_CONFLICT on differing metadata", async () => {
    const f = await fixture("conflict");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload: { version: "web@2.0.0", commitSha: "abc1234" },
    });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload: { version: "web@2.0.0", commitSha: "def5678" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "RELEASE_VERSION_CONFLICT" });
    // Stored row is untouched.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
    });
    const releases = (list.json() as { releases: ReleaseBody[] }).releases;
    expect(releases).toHaveLength(1);
    expect(releases[0]?.commit).toBe("abc1234");
  });

  it("rejects invalid versions, SHAs and URLs with 400", async () => {
    const f = await fixture("invalid");
    const badPayloads = [
      { version: "" },
      { version: "v1.0\n" },
      { version: "ok@1.0.0", commitSha: "short" },
      { version: "ok@1.0.0", commitSha: "zzzzzzz" },
      { version: "ok@1.0.1", repositoryUrl: "ftp://example.com/x" },
      { version: "ok@1.0.2", repositoryUrl: "github.com/acme/app" },
    ];
    for (const payload of badPayloads) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cli/releases",
        headers: { authorization: `Bearer ${f.token}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect((list.json() as { releases: unknown[] }).releases).toEqual([]);
  });

  it("lists releases deterministically with artifact counts", async () => {
    const f = await fixture("list");
    for (const version of ["zeta@1.0.0", "alpha@1.0.0", "mid@1.0.0"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cli/releases",
        headers: { authorization: `Bearer ${f.token}` },
        payload: { version },
      });
      expect(res.statusCode).toBe(201);
    }
    // One artifact on alpha: count wiring proof.
    const alpha = await ReleaseRepo.findReleaseByProjectAndVersion(
      dbClient.db,
      f.projectId,
      "alpha@1.0.0",
    );
    expect(alpha).toBeDefined();
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: alpha!.id,
      artifactPath: "assets/app.js.map",
      storageKey: `${f.projectId}/${alpha!.id}/hash`,
      contentHash: "a".repeat(64),
      sizeBytes: 128,
      artifactType: "source_map",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      releases: Array<{
        version: string;
        commit: string | null;
        artifactCount: number;
        createdAt: string;
      }>;
    };
    // Created sequentially: created_at order wins over version order.
    expect(body.releases.map((r) => r.version)).toEqual([
      "zeta@1.0.0",
      "alpha@1.0.0",
      "mid@1.0.0",
    ]);
    const counts = new Map(
      body.releases.map((r) => [r.version, r.artifactCount]),
    );
    expect(counts.get("alpha@1.0.0")).toBe(1);
    expect(counts.get("zeta@1.0.0")).toBe(0);
    for (const item of body.releases) {
      expect(Object.keys(item).sort()).toEqual(
        ["artifactCount", "commit", "createdAt", "version"].sort(),
      );
      expect(typeof item.createdAt).toBe("string");
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(f.token);
    expect(serialized).not.toMatch(/storageKey|keyHash|secret/i);
    // Stable across calls.
    const again = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(again.json()).toEqual(body);
  });

  it("isolates versions across projects", async () => {
    const a = await fixture("proj-a");
    const b = await fixture("proj-b");
    for (const f of [a, b]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/cli/releases",
        headers: { authorization: `Bearer ${f.token}` },
        payload: { version: "shared@1.0.0" },
      });
      expect(res.statusCode).toBe(201);
    }
    for (const f of [a, b]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/cli/releases",
        headers: { authorization: `Bearer ${f.token}` },
      });
      const releases = (res.json() as { releases: ReleaseBody[] }).releases;
      expect(releases).toHaveLength(1);
      expect(releases[0]?.version).toBe("shared@1.0.0");
    }
  });

  it("denies public ingest keys, session cookies and revoked tokens", async () => {
    const f = await fixture("denied");
    const withPublic = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.bootstrapKey}` },
      payload: { version: "x@1.0.0" },
    });
    expect(withPublic.statusCode).toBe(401);

    const withCookie = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { cookie: f.cookie },
      payload: { version: "x@1.0.0" },
    });
    expect(withCookie.statusCode).toBe(401);

    const listWithCookie = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { cookie: f.cookie },
    });
    expect(listWithCookie.statusCode).toBe(401);

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
    });
    expect(missing.statusCode).toBe(401);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${f.projectId}/secret-tokens/${f.tokenId}/revoke`,
      headers: { cookie: f.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
      payload: { version: "x@1.0.0" },
    });
    expect(afterRevoke.statusCode).toBe(401);
    const listAfterRevoke = await app.inject({
      method: "GET",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${f.token}` },
    });
    expect(listAfterRevoke.statusCode).toBe(401);
  });
});
