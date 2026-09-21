import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStorage,
  buildArtifactStorageKey,
} from "@replaybug/artifacts";
import { MembershipRepo, ReleaseRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

type Session = { cookies: string[]; userId: string };

async function signup(app: AppInstance, email: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Deletion Tester" },
  });
  expect([200, 201]).toContain(response.statusCode);
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : raw === undefined
      ? []
      : [String(raw)];
  const body = response.json() as { user?: { id?: string } };
  const userId = body.user?.id;
  if (userId === undefined) {
    throw new Error("signup did not return a user id");
  }
  return { cookies, userId };
}

async function createWorkspace(
  app: AppInstance,
  session: Session,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie: cookiesHeader(session.cookies) },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; slug: string };
}

async function createProject(
  app: AppInstance,
  session: Session,
  workspaceId: string,
  name: string,
): Promise<{ id: string; slug: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/projects`,
    headers: { cookie: cookiesHeader(session.cookies) },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    project: { id: string; slug: string };
  };
  return body.project;
}

function artifactHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("durable project and workspace deletion (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let artifactRoot: string;
  let storage: LocalArtifactStorage;

  beforeAll(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "replaybug-api-deletion-"));
    storage = new LocalArtifactStorage({ root: artifactRoot });
    dbClient = createTestDbClient();
    app = await buildApp({
      config: testApiConfig(),
      dbClient,
      artifactStorage: storage,
    });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("requires an exact project slug and leaves inaccessible projects unenumerable", async () => {
    const owner = await signup(
      app,
      `delete-project-${randomUUID()}@example.com`,
    );
    const workspace = await createWorkspace(
      app,
      owner,
      "Delete Project Workspace",
    );
    const project = await createProject(app, owner, workspace.id, "Delete Me");
    const cookie = cookiesHeader(owner.cookies);
    const url = `/api/v1/projects/${project.id}`;

    const missing = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(400);

    const extra = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
      payload: { confirmation: project.slug, extra: true },
    });
    expect(extra.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
      payload: { confirmation: project.slug.toUpperCase() },
    });
    expect(wrong.statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url, headers: { cookie } }))
        .statusCode,
    ).toBe(200);

    const outsider = await signup(
      app,
      `delete-outsider-${randomUUID()}@example.com`,
    );
    const inaccessible = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookiesHeader(outsider.cookies) },
      payload: { confirmation: project.slug },
    });
    expect(inaccessible.statusCode).toBe(404);

    const deleted = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
      payload: { confirmation: project.slug },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });

    const repeated = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie },
      payload: { confirmation: project.slug },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({ deleted: false });
  });

  it("queues every artifact before project cascade and preserves detached outbox rows", async () => {
    const owner = await signup(
      app,
      `queue-project-${randomUUID()}@example.com`,
    );
    const workspace = await createWorkspace(
      app,
      owner,
      "Queue Project Workspace",
    );
    const project = await createProject(
      app,
      owner,
      workspace.id,
      "Queue Project",
    );
    const bytes = Buffer.from("source-map fixture");
    const release = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: project.id,
      version: "queue-test",
    });
    const storageKey = buildArtifactStorageKey(
      project.id,
      release.row.id,
      artifactHash(bytes),
    );
    await storage.put(storageKey, Readable.from([bytes]));
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: release.row.id,
      artifactPath: "assets/app.js.map",
      storageKey,
      contentHash: artifactHash(bytes),
      sizeBytes: bytes.byteLength,
      artifactType: "source_map",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: cookiesHeader(owner.cookies) },
      payload: { confirmation: project.slug },
    });
    expect(response.statusCode).toBe(200);
    expect(await storage.exists(storageKey)).toBe(true);

    const outbox = await dbClient.pool.query<{
      project_id: string | null;
      storage_key: string;
      completed_at: Date | null;
    }>(
      "SELECT project_id, storage_key, completed_at FROM artifact_deletion_outbox WHERE storage_key = $1",
      [storageKey],
    );
    expect(outbox.rows).toEqual([
      { project_id: null, storage_key: storageKey, completed_at: null },
    ]);
    const remainingProject = await dbClient.pool.query(
      "SELECT id FROM projects WHERE id = $1",
      [project.id],
    );
    const remainingRelease = await dbClient.pool.query(
      "SELECT id FROM releases WHERE id = $1",
      [release.row.id],
    );
    expect(remainingProject.rowCount).toBe(0);
    expect(remainingRelease.rowCount).toBe(0);
    const audit = await dbClient.pool.query<{
      action: string;
      project_id: string | null;
    }>(
      "SELECT action, project_id FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspace.id],
    );
    expect(audit.rows.every((row) => row.project_id === null)).toBe(true);
    expect(audit.rows.map((row) => row.action).sort()).toEqual(
      [
        "workspace.created",
        "project.created",
        "project.deletion_requested",
        "project.deletion_completed",
      ].sort(),
    );
  });

  it("allows only the current workspace owner to delete with exact confirmation", async () => {
    const owner = await signup(
      app,
      `delete-workspace-${randomUUID()}@example.com`,
    );
    const member = await signup(
      app,
      `delete-member-${randomUUID()}@example.com`,
    );
    const workspace = await createWorkspace(app, owner, "Delete Workspace");
    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId: workspace.id,
      userId: member.userId,
      role: "member",
    });
    const project = await createProject(
      app,
      owner,
      workspace.id,
      "Child Project",
    );
    const bytes = Buffer.from("workspace artifact fixture");
    const release = await ReleaseRepo.createRelease(dbClient.db, {
      projectId: project.id,
      version: "workspace-delete-test",
    });
    const hash = artifactHash(bytes);
    const storageKey = buildArtifactStorageKey(
      project.id,
      release.row.id,
      hash,
    );
    await storage.put(storageKey, Readable.from([bytes]));
    await ReleaseRepo.insertReleaseArtifact(dbClient.db, {
      releaseId: release.row.id,
      artifactPath: "assets/workspace.js.map",
      storageKey,
      contentHash: hash,
      sizeBytes: bytes.byteLength,
      artifactType: "source_map",
    });

    const memberAttempt = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}`,
      headers: { cookie: cookiesHeader(member.cookies) },
      payload: { confirmation: workspace.slug },
    });
    expect(memberAttempt.statusCode).toBe(403);

    const wrong = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}`,
      headers: { cookie: cookiesHeader(owner.cookies) },
      payload: { confirmation: "Delete Workspace" },
    });
    expect(wrong.statusCode).toBe(400);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}`,
      headers: { cookie: cookiesHeader(owner.cookies) },
      payload: { confirmation: workspace.slug },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(await storage.exists(storageKey)).toBe(true);
    const outbox = await dbClient.pool.query<{
      project_id: string | null;
      storage_key: string;
      completed_at: Date | null;
    }>(
      "SELECT project_id, storage_key, completed_at FROM artifact_deletion_outbox WHERE storage_key = $1",
      [storageKey],
    );
    expect(outbox.rows).toEqual([
      { project_id: null, storage_key: storageKey, completed_at: null },
    ]);
    expect(
      (
        await dbClient.pool.query("SELECT id FROM projects WHERE id = $1", [
          project.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await dbClient.pool.query("SELECT id FROM workspaces WHERE id = $1", [
          workspace.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await dbClient.pool.query(
          "SELECT COUNT(*)::int AS count FROM audit_logs WHERE workspace_id = $1",
          [workspace.id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});
