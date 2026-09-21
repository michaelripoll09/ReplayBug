import { randomUUID } from "node:crypto";
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

async function userIdFor(app: AppInstance, cookie: string): Promise<string> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

interface DashboardReleaseItem {
  id: string;
  version: string;
  commitSha: string | null;
  repositoryUrl: string | null;
  createdAt: string;
  artifactCount: number;
  sourceMapCount: number;
  minifiedAssetCount: number;
  occurrenceCount: number;
  hasSourceMaps: boolean;
}

interface DashboardReleaseDetail extends DashboardReleaseItem {
  artifacts: Array<{
    id: string;
    artifactPath: string;
    artifactType: string;
    contentHash: string;
    sizeBytes: number;
    createdAt: string;
  }>;
}

/**
 * RS-10 session-authenticated dashboard release reads (real PG):
 * session-only auth, all-members readable, counts, metadata without
 * storage keys, cross-tenant isolation.
 */
describe("RS-10 dashboard releases (real PG)", () => {
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
    workspaceId: string;
    projectId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cookie = await signup(app, `dashrel-${name}-${stamp}@example.com`);
    const { workspaceId, projectId } = await createWorkspaceAndProject(
      app,
      cookie,
      `DashRel WS ${name} ${stamp}`,
      `DashRel Proj ${name} ${stamp}`,
    );
    return { cookie, workspaceId, projectId };
  }

  async function addMember(
    workspaceId: string,
    email: string,
    role: "member" | "viewer" | "admin",
  ): Promise<string> {
    const cookie = await signup(app, email);
    const userId = await userIdFor(app, cookie);
    await dbClient.pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`,
      [workspaceId, userId, role],
    );
    return cookie;
  }

  async function seedTelemetry(
    projectId: string,
    release: string,
    count: number,
  ): Promise<void> {
    const sessionId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, $3, 'production', 'https://example.com/', 't@0')`,
      [sessionId, projectId, `sdk-${randomUUID().slice(0, 8)}`],
    );
    for (let i = 0; i < count; i += 1) {
      await dbClient.pool.query(
        `INSERT INTO events
           ("project_id", "telemetry_session_id", "client_event_id",
            "sequence_number", "event_type", "occurred_at",
            "environment", "release", "payload_json", "processing_state")
         VALUES ($1, $2, $3, $4, 'message', now(),
                 'production', $5, '{"message": "hi", "level": "info"}',
                 'processed')`,
        [projectId, sessionId, randomUUID(), i + 1, release],
      );
    }
  }

  it("requires session auth: anonymous and CLI bearer tokens are 401", async () => {
    const f = await fixture("auth");
    const release = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: f.projectId,
      version: "web@1.0.0",
    });
    for (const url of [
      `/api/v1/projects/${f.projectId}/releases`,
      `/api/v1/projects/${f.projectId}/releases/${release.row.id}`,
    ]) {
      const anon = await app.inject({ method: "GET", url });
      expect(anon.statusCode).toBe(401);
      // CLI bearer tokens are never consulted on dashboard routes.
      const bearer = await app.inject({
        method: "GET",
        url,
        headers: {
          authorization:
            "Bearer rb_sk_12345678_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
      expect(bearer.statusCode).toBe(401);
    }
  });

  it("lets every project member read: owner, admin, member and viewer", async () => {
    const f = await fixture("roles");
    const stamp = `${Date.now()}`;
    const adminCookie = await addMember(
      f.workspaceId,
      `dashrel-admin-${stamp}@example.com`,
      "admin",
    );
    const memberCookie = await addMember(
      f.workspaceId,
      `dashrel-member-${stamp}@example.com`,
      "member",
    );
    const viewerCookie = await addMember(
      f.workspaceId,
      `dashrel-viewer-${stamp}@example.com`,
      "viewer",
    );
    const release = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: f.projectId,
      version: "web@9.9.9",
    });
    for (const cookie of [f.cookie, adminCookie, memberCookie, viewerCookie]) {
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${f.projectId}/releases`,
        headers: { cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${f.projectId}/releases/${release.row.id}`,
        headers: { cookie },
      });
      expect(detail.statusCode).toBe(200);
    }
  });

  it("hides cross-tenant projects and releases as NOT_FOUND", async () => {
    const a = await fixture("tenant-a");
    const b = await fixture("tenant-b");
    const release = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: a.projectId,
      version: "web@1.0.0",
    });
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${a.projectId}/releases`,
      headers: { cookie: b.cookie },
    });
    expect(list.statusCode).toBe(404);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${a.projectId}/releases/${release.row.id}`,
      headers: { cookie: b.cookie },
    });
    expect(detail.statusCode).toBe(404);
    // A release id from another project must not resolve under this one.
    const crossed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${b.projectId}/releases/${release.row.id}`,
      headers: { cookie: b.cookie },
    });
    expect(crossed.statusCode).toBe(404);
  });

  it("lists releases with counts and status summary, never storage keys", async () => {
    const f = await fixture("list");
    const withMaps = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: f.projectId,
      version: "web@1.4.2",
      commitSha: "abc1234",
      repositoryUrl: "https://github.com/acme/app",
    });
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: withMaps.row.id,
      artifactPath: "assets/app.js.map",
      storageKey: "SECRET-STORAGE-KEY-MAP",
      contentHash: "a".repeat(64),
      sizeBytes: 1024,
      artifactType: "source_map",
    });
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: withMaps.row.id,
      artifactPath: "assets/app.js",
      storageKey: "SECRET-STORAGE-KEY-JS",
      contentHash: "b".repeat(64),
      sizeBytes: 2048,
      artifactType: "minified_asset",
    });
    const bare = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: f.projectId,
      version: "web@1.4.3",
    });
    await seedTelemetry(f.projectId, "web@1.4.2", 3);
    await seedTelemetry(f.projectId, "web@1.4.3", 1);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${f.projectId}/releases`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as DashboardReleaseItem[];
    expect(items).toHaveLength(2);
    const byVersion = new Map(items.map((i) => [i.version, i]));
    expect(byVersion.get("web@1.4.2")).toMatchObject({
      id: withMaps.row.id,
      version: "web@1.4.2",
      commitSha: "abc1234",
      repositoryUrl: "https://github.com/acme/app",
      artifactCount: 2,
      sourceMapCount: 1,
      minifiedAssetCount: 1,
      occurrenceCount: 3,
      hasSourceMaps: true,
    });
    expect(byVersion.get("web@1.4.3")).toMatchObject({
      id: bare.row.id,
      artifactCount: 0,
      sourceMapCount: 0,
      minifiedAssetCount: 0,
      occurrenceCount: 1,
      hasSourceMaps: false,
    });
    for (const item of items) {
      expect(typeof item.createdAt).toBe("string");
      expect(Object.keys(item).sort()).toEqual(
        [
          "id",
          "version",
          "commitSha",
          "repositoryUrl",
          "createdAt",
          "artifactCount",
          "sourceMapCount",
          "minifiedAssetCount",
          "occurrenceCount",
          "hasSourceMaps",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("SECRET-STORAGE-KEY-MAP");
    expect(serialized).not.toContain("SECRET-STORAGE-KEY-JS");
    expect(serialized).not.toMatch(/storage_key|storageKey/i);
  });

  it("returns an empty list when the project has no releases", async () => {
    const f = await fixture("empty");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${f.projectId}/releases`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns release detail with artifact metadata, never storage keys", async () => {
    const f = await fixture("detail");
    const created = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: f.projectId,
      version: "web@2.0.0",
      commitSha: "def5678",
    });
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: created.row.id,
      artifactPath: "assets/bundle.min.js.map",
      storageKey: "SECRET-STORAGE-KEY-DETAIL",
      contentHash: "c".repeat(64),
      sizeBytes: 512,
      artifactType: "source_map",
    });
    await seedTelemetry(f.projectId, "web@2.0.0", 2);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${f.projectId}/releases/${created.row.id}`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DashboardReleaseDetail;
    expect(body).toMatchObject({
      id: created.row.id,
      version: "web@2.0.0",
      commitSha: "def5678",
      artifactCount: 1,
      sourceMapCount: 1,
      minifiedAssetCount: 0,
      occurrenceCount: 2,
      hasSourceMaps: true,
    });
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({
      artifactPath: "assets/bundle.min.js.map",
      artifactType: "source_map",
      contentHash: "c".repeat(64),
      sizeBytes: 512,
    });
    expect(typeof body.artifacts[0]?.id).toBe("string");
    expect(typeof body.artifacts[0]?.createdAt).toBe("string");
    expect(body.artifacts[0]).not.toHaveProperty("storageKey");
    expect(body.artifacts[0]).not.toHaveProperty("storage_key");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET-STORAGE-KEY-DETAIL");
    expect(serialized).not.toMatch(/storage_key|storageKey/i);
  });

  it("returns 404 for unknown release ids and malformed project ids", async () => {
    const f = await fixture("missing");
    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${f.projectId}/releases/${randomUUID()}`,
      headers: { cookie: f.cookie },
    });
    expect(unknown.statusCode).toBe(404);
    const badProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${randomUUID()}/releases`,
      headers: { cookie: f.cookie },
    });
    expect(badProject.statusCode).toBe(404);
  });

  it("extends event detail with a raw-only diagnostic when never symbolicated", async () => {
    const f = await fixture("diag-raw");
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"e".repeat(64)}', 'sig', 'exception',
               'TypeError: boom', 'TypeError: boom', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, f.projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, 'sdk-diag', 'production',
               'https://example.com/', 't@0')`,
      [sessionId, f.projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "payload_json",
          "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 1, 'exception', now(),
               'production', 'web@3.0.0',
               '{"values": [{"type": "TypeError", "value": "boom",
                 "stacktrace": {"frames": [
                   {"filename": "https://example.com/assets/app.js",
                    "function": "onClick", "lineno": 1, "colno": 2,
                    "in_app": true}]}}]}',
               $5, 'processed')`,
      [eventId, f.projectId, sessionId, randomUUID(), issueId],
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/events/${eventId}`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      diagnostic: {
        symbolicationStatus: string | null;
        rawFrames: Array<{ filename?: string }>;
        mappedFrames: unknown;
        preferredStack: unknown[];
      };
    };
    expect(body.diagnostic.symbolicationStatus).toBeNull();
    expect(body.diagnostic.mappedFrames).toBeNull();
    expect(body.diagnostic.rawFrames).toHaveLength(1);
    expect(body.diagnostic.rawFrames[0]).toMatchObject({
      filename: "https://example.com/assets/app.js",
      function: "onClick",
    });
    expect(body.diagnostic.preferredStack).toEqual(body.diagnostic.rawFrames);
  });

  it("extends event detail with a mapped diagnostic from worker enrichment", async () => {
    const f = await fixture("diag-mapped");
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"f".repeat(64)}', 'sig', 'exception',
               'TypeError: boom', 'TypeError: boom', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, f.projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, 'sdk-mapped', 'production',
               'https://example.com/', 't@0')`,
      [sessionId, f.projectId],
    );
    const symbolication = {
      status: "mapped",
      rawFrames: [
        {
          filename: "https://example.com/assets/app.js",
          function: "a",
          lineno: 1,
          colno: 11,
          inApp: true,
        },
      ],
      mappedFrames: [
        {
          filename: "https://example.com/assets/app.js",
          source: "src/app.ts",
          function: "a",
          name: "onClick",
          line: 10,
          column: 5,
          inApplication: true,
          mapped: true,
        },
      ],
      mappedFrameCount: 1,
      // Arbitrary junk must never reach the DTO.
      storageKey: "SECRET-STORAGE-KEY-SHOULD-NOT-LEAK",
    };
    await dbClient.pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "payload_json", "symbolication_json",
          "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 1, 'exception', now(),
               'production', 'web@3.0.1',
               '{"values": [{"type": "TypeError", "value": "boom"}]}',
               $5, $6, 'processed')`,
      [
        eventId,
        f.projectId,
        sessionId,
        randomUUID(),
        JSON.stringify(symbolication),
        issueId,
      ],
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/events/${eventId}`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      symbolication: { status: string; mappedFrameCount: number };
      diagnostic: {
        symbolicationStatus: string | null;
        rawFrames: unknown[];
        mappedFrames: Array<{ source: string; name: string | null }>;
        preferredStack: unknown[];
      };
    };
    expect(body.symbolication.status).toBe("mapped");
    expect(body.symbolication.mappedFrameCount).toBe(1);
    expect(body.diagnostic.symbolicationStatus).toBe("mapped");
    expect(body.diagnostic.mappedFrames).toHaveLength(1);
    expect(body.diagnostic.mappedFrames[0]).toMatchObject({
      source: "src/app.ts",
      name: "onClick",
    });
    expect(body.diagnostic.preferredStack).toEqual(
      body.diagnostic.mappedFrames,
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET-STORAGE-KEY-SHOULD-NOT-LEAK");
    expect(serialized).not.toMatch(/storage_key|storageKey/i);
  });

  it("degrades corrupt symbolication enrichment to raw-only without leaking", async () => {
    const f = await fixture("diag-corrupt");
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"a".repeat(64)}', 'sig', 'exception',
               'TypeError: boom', 'TypeError: boom', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, f.projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, 'sdk-corrupt', 'production',
               'https://example.com/', 't@0')`,
      [sessionId, f.projectId],
    );
    await dbClient.pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "payload_json", "symbolication_json",
          "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 1, 'exception', now(),
               'production', 'web@3.0.2',
               '{"values": [{"type": "TypeError", "value": "boom"}]}',
               '{"status": "mapped", "exploit": "SECRET-DB-DUMP",
                 "rawFrames": "not-an-array"}',
               $5, 'processed')`,
      [eventId, f.projectId, sessionId, randomUUID(), issueId],
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/events/${eventId}`,
      headers: { cookie: f.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      diagnostic: {
        symbolicationStatus: string | null;
        mappedFrames: unknown;
      };
    };
    expect(body.diagnostic.symbolicationStatus).toBeNull();
    expect(body.diagnostic.mappedFrames).toBeNull();
    expect(JSON.stringify(body)).not.toContain("SECRET-DB-DUMP");
  });
});
