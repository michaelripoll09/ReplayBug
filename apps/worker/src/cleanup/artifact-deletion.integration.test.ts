import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactDeletionRepo,
  ReleaseRepo,
  type DbClient,
} from "@replaybug/db";
import {
  buildArtifactStorageKey,
  type ArtifactStorage,
  LocalArtifactStorage,
} from "@replaybug/artifacts";
import {
  createTestLogger,
  createWorkerTestDatabase,
  seedProject,
  type WorkerTestDatabase,
} from "../test-helpers.js";
import {
  runArtifactDeletionBatch,
  startArtifactDeletionRunner,
} from "./artifact-deletion.js";

function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("artifact deletion cleanup (real PG and filesystem)", () => {
  let testDb: WorkerTestDatabase;
  let client: DbClient;
  let storageRoot: string;
  let storage: LocalArtifactStorage;

  beforeEach(async () => {
    testDb = await createWorkerTestDatabase();
    client = testDb.client;
    storageRoot = await mkdtemp(join(tmpdir(), "replaybug-worker-artifacts-"));
    storage = new LocalArtifactStorage({ root: storageRoot });
  });

  afterEach(async () => {
    await testDb.drop();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function enqueueStoredArtifact(): Promise<{
    projectId: string;
    releaseId: string;
    storageKey: string;
  }> {
    const seeded = await seedProject(client);
    const bytes = Buffer.from(`artifact-${randomUUID()}`);
    const release = await ReleaseRepo.createRelease(client.db, {
      projectId: seeded.projectId,
      version: `release-${randomUUID()}`,
    });
    const hash = contentHash(bytes);
    const storageKey = buildArtifactStorageKey(
      seeded.projectId,
      release.row.id,
      hash,
    );
    await storage.put(storageKey, Readable.from([bytes]));
    await ReleaseRepo.insertReleaseArtifact(client.db, {
      releaseId: release.row.id,
      artifactPath: "assets/app.js.map",
      storageKey,
      contentHash: hash,
      sizeBytes: bytes.byteLength,
      artifactType: "source_map",
    });
    await ArtifactDeletionRepo.insertArtifactDeletionOutbox(client.db, {
      projectId: seeded.projectId,
      storageKey,
    });
    return {
      projectId: seeded.projectId,
      releaseId: release.row.id,
      storageKey,
    };
  }

  it("deletes a real file, treats a missing file as success, and is idempotent", async () => {
    const artifact = await enqueueStoredArtifact();
    const first = await runArtifactDeletionBatch({
      db: client.db,
      storage,
      batchSize: 10,
    });
    expect(first).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(await storage.exists(artifact.storageKey)).toBe(false);

    const second = await runArtifactDeletionBatch({
      db: client.db,
      storage,
      batchSize: 10,
    });
    expect(second).toEqual({ claimed: 0, completed: 0, failed: 0 });
    const row = await client.pool.query<{
      completed_at: Date | null;
      attempt_count: number;
      last_error: string | null;
    }>(
      "SELECT completed_at, attempt_count, last_error FROM artifact_deletion_outbox WHERE storage_key = $1",
      [artifact.storageKey],
    );
    expect(row.rows[0]?.completed_at).not.toBeNull();
    expect(row.rows[0]?.attempt_count).toBe(0);
    expect(row.rows[0]?.last_error).toBeNull();
  });

  it("deduplicates enqueue, records sanitized outage metadata, and recovers on retry", async () => {
    const artifact = await enqueueStoredArtifact();
    const duplicate = await ArtifactDeletionRepo.insertArtifactDeletionOutbox(
      client.db,
      { projectId: artifact.projectId, storageKey: artifact.storageKey },
    );
    const count = await client.pool.query(
      "SELECT COUNT(*)::int AS count FROM artifact_deletion_outbox WHERE storage_key = $1",
      [artifact.storageKey],
    );
    expect(count.rows[0]?.count).toBe(1);
    expect(duplicate.storageKey).toBe(artifact.storageKey);

    const failingStorage: ArtifactStorage = {
      root: storage.root,
      put: (key, source) => storage.put(key, source),
      get: (key) => storage.get(key),
      exists: (key) => storage.exists(key),
      delete: async () => {
        throw new Error(`outage ${storage.root} ${artifact.storageKey}`);
      },
    };
    const failed = await runArtifactDeletionBatch({
      db: client.db,
      storage: failingStorage,
      batchSize: 10,
    });
    expect(failed).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const retryRow = await client.pool.query<{
      attempt_count: number;
      last_error: string | null;
    }>(
      "SELECT attempt_count, last_error FROM artifact_deletion_outbox WHERE storage_key = $1",
      [artifact.storageKey],
    );
    expect(retryRow.rows[0]).toEqual({
      attempt_count: 1,
      last_error: "storage_unavailable",
    });
    expect(retryRow.rows[0]?.last_error).not.toContain(artifact.storageKey);
    expect(retryRow.rows[0]?.last_error).not.toContain(storage.root);

    const recovered = await runArtifactDeletionBatch({
      db: client.db,
      storage,
      batchSize: 10,
    });
    expect(recovered).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(await storage.exists(artifact.storageKey)).toBe(false);
  });

  it("rejects malformed outbox keys without touching storage and drains runner stop", async () => {
    const seeded = await seedProject(client);
    const malformed = `${seeded.projectId}/not-a-release/${"a".repeat(64)}`;
    await client.pool.query(
      `INSERT INTO artifact_deletion_outbox (project_id, storage_key)
       VALUES ($1, $2)`,
      [seeded.projectId, malformed],
    );
    const invalid = await runArtifactDeletionBatch({
      db: client.db,
      storage,
      batchSize: 10,
    });
    expect(invalid).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const invalidRow = await client.pool.query<{ last_error: string | null }>(
      "SELECT last_error FROM artifact_deletion_outbox WHERE storage_key = $1",
      [malformed],
    );
    expect(invalidRow.rows[0]?.last_error).toBe("invalid_storage_key");

    const runner = startArtifactDeletionRunner({
      db: client.db,
      storage,
      batchSize: 10,
      intervalMs: 60_000,
      logger: createTestLogger(),
    });
    await expect(runner.stop()).resolves.toBeUndefined();
  });
});
