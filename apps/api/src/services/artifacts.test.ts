import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalArtifactStorage, sha256Hex } from "@replaybug/artifacts";
import type { ArtifactStorage } from "@replaybug/artifacts";
import {
  checkArtifactPreflight,
  drizzleArtifactRecordStore,
  finalizeArtifactUpload,
  stageRawUpload,
  uploadReleaseArtifact,
  type ArtifactRecord,
  type ArtifactRecordStore,
  type NewArtifactRecord,
} from "./artifacts.js";
import { DomainError } from "../errors.js";

/**
 * RS-06 upload service units (TDD): real filesystem temp dirs + real
 * LocalArtifactStorage, in-memory record store (real PG covered by the
 * route integration suite). Proves server-side hashing wins, idempotent
 * same-hash returns, conflict no-overwrite, compensation on DB/storage
 * failure, and temp cleanup on every outcome.
 */

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";
const RELEASE_ID = "223e4567-e89b-12d3-a456-426614174001";
const HELLO_SHA =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const VALID_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: [],
  mappings: "AAAA",
});

function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return Readable.from([Buffer.from(bytes)]);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function storeKey(releaseId: string, artifactPath: string): string {
  return `${releaseId}::${artifactPath}`;
}

interface MemoryStore extends ArtifactRecordStore {
  rows: Map<string, ArtifactRecord>;
  insertCalls: number;
  failOnInsert: Error | null;
}

function createMemoryStore(): MemoryStore {
  const rows = new Map<string, ArtifactRecord>();
  const store: MemoryStore = {
    rows,
    insertCalls: 0,
    failOnInsert: null,
    findByPath: async (releaseId, artifactPath) =>
      rows.get(storeKey(releaseId, artifactPath)),
    insert: async (record: NewArtifactRecord) => {
      store.insertCalls += 1;
      if (store.failOnInsert !== null) {
        throw store.failOnInsert;
      }
      const row: ArtifactRecord = {
        ...record,
        id: randomUUID(),
        createdAt: new Date(),
      };
      rows.set(storeKey(record.releaseId, record.artifactPath), row);
      return row;
    },
  };
  return store;
}

function releaseRef(): { id: string; projectId: string } {
  return { id: RELEASE_ID, projectId: PROJECT_ID };
}

async function stagingIsEmpty(stagingDir: string): Promise<boolean> {
  return (await readdir(stagingDir)).length === 0;
}

describe("uploadReleaseArtifact (real FS, memory store)", () => {
  let storageRoot = "";
  let stagingDir = "";
  let storage: ArtifactStorage;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "rs06-svc-storage-"));
    stagingDir = await mkdtemp(join(tmpdir(), "rs06-svc-staging-"));
    storage = new LocalArtifactStorage({ root: storageRoot });
  });

  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  it("stores bytes under the server-computed SHA-256", async () => {
    const store = createMemoryStore();
    const expected = sha256Hex(bytesOf(VALID_MAP));
    const result = await uploadReleaseArtifact(
      store,
      storage,
      releaseRef(),
      {
        artifactPath: "assets/app.js.map",
        artifactType: "source_map",
        mimeType: "application/json",
        source: streamOf(bytesOf(VALID_MAP)),
      },
      { maxFileBytes: 1024, stagingDir },
    );
    expect(result.created).toBe(true);
    expect(result.record.contentHash).toBe(expected);
    expect(result.record.sizeBytes).toBe(bytesOf(VALID_MAP).length);
    expect(result.record.artifactPath).toBe("assets/app.js.map");
    // Sanity: the digest helper matches Node crypto on known bytes.
    expect(HELLO_SHA).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("derives the artifact type from the extension and rejects mismatches", async () => {
    const store = createMemoryStore();
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/app.js",
          artifactType: "source_map",
          source: streamOf(bytesOf("var a = 1;")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("is idempotent for same path+hash without a second insert", async () => {
    const store = createMemoryStore();
    const first = await uploadReleaseArtifact(
      store,
      storage,
      releaseRef(),
      {
        artifactPath: "assets/idem.js",
        artifactType: "minified_asset",
        mimeType: "application/octet-stream",
        source: streamOf(bytesOf("var a = 1;")),
      },
      { maxFileBytes: 1024, stagingDir },
    );
    expect(first.created).toBe(true);
    const second = await uploadReleaseArtifact(
      store,
      storage,
      releaseRef(),
      {
        artifactPath: "assets/idem.js",
        artifactType: "minified_asset",
        source: streamOf(bytesOf("var a = 1;")),
      },
      { maxFileBytes: 1024, stagingDir },
    );
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(store.insertCalls).toBe(1);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("conflicts on same path with different hash without overwriting", async () => {
    const store = createMemoryStore();
    const original = bytesOf("var a = 1;");
    await uploadReleaseArtifact(
      store,
      storage,
      releaseRef(),
      {
        artifactPath: "assets/locked.js",
        artifactType: "minified_asset",
        source: streamOf(original),
      },
      { maxFileBytes: 1024, stagingDir },
    );
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/locked.js",
          artifactType: "minified_asset",
          source: streamOf(bytesOf("var a = 2;")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_CONFLICT" });
    const stored = store.rows.get(storeKey(RELEASE_ID, "assets/locked.js"));
    expect(stored?.contentHash).toBe(sha256Hex(original));
    // Stored bytes on disk are unchanged.
    const stream = await storage.get(stored?.storageKey ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("var a = 1;");
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("rejects traversal paths with no staging residue", async () => {
    const store = createMemoryStore();
    for (const candidate of [
      "../escape.map",
      "C:\\evil.map",
      "/abs.map",
      "assets/nul.map",
    ]) {
      await expect(
        uploadReleaseArtifact(
          store,
          storage,
          releaseRef(),
          {
            artifactPath: candidate,
            artifactType: "source_map",
            source: streamOf(bytesOf(VALID_MAP)),
          },
          { maxFileBytes: 1024, stagingDir },
        ),
      ).rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" });
    }
    expect(store.insertCalls).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("rejects over-limit bytes with 413 and cleans staging + storage", async () => {
    const store = createMemoryStore();
    const bytes = bytesOf("0123456789abcdef");
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/big.js",
          artifactType: "minified_asset",
          source: streamOf(bytes),
        },
        { maxFileBytes: bytes.length - 1, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    expect(store.insertCalls).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("accepts exactly-at-limit bytes", async () => {
    const store = createMemoryStore();
    const bytes = bytesOf("var a = 1;");
    const result = await uploadReleaseArtifact(
      store,
      storage,
      releaseRef(),
      {
        artifactPath: "assets/edge.js",
        artifactType: "minified_asset",
        source: streamOf(bytes),
      },
      { maxFileBytes: bytes.length, stagingDir },
    );
    expect(result.created).toBe(true);
    expect(result.record.sizeBytes).toBe(bytes.length);
  });

  it("rejects malformed source maps with nothing persisted", async () => {
    const store = createMemoryStore();
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/broken.js.map",
          artifactType: "source_map",
          source: streamOf(bytesOf("not json")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_MAP" });
    expect(store.insertCalls).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("rejects renamed executables and markup as assets", async () => {
    const store = createMemoryStore();
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/evil.js",
          artifactType: "minified_asset",
          source: streamOf(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/page.js",
          artifactType: "minified_asset",
          source: streamOf(bytesOf("<!doctype html>")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    expect(store.insertCalls).toBe(0);
  });

  it("rejects disallowed extensions and dangerous MIME types", async () => {
    const store = createMemoryStore();
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "payload.exe",
          artifactType: "minified_asset",
          source: streamOf(bytesOf("var a = 1;")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/app.js",
          artifactType: "minified_asset",
          mimeType: "text/html",
          source: streamOf(bytesOf("var a = 1;")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    expect(store.insertCalls).toBe(0);
  });

  it("deletes the stored file when the DB insert fails (compensation)", async () => {
    const store = createMemoryStore();
    store.failOnInsert = new Error("simulated PG outage");
    const bytes = bytesOf("var comp = 1;");
    const expectedHash = sha256Hex(bytes);
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/comp.js",
          artifactType: "minified_asset",
          source: streamOf(bytes),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toThrow("simulated PG outage");
    const key = `${PROJECT_ID}/${RELEASE_ID}/${expectedHash}`;
    expect(await storage.exists(key)).toBe(false);
    expect(store.rows.size).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("maps storage outages to 503 with no row", async () => {
    const store = createMemoryStore();
    const failing: ArtifactStorage = {
      root: storage.root,
      put: async () => {
        const { ArtifactStorageError } = await import("@replaybug/artifacts");
        throw new ArtifactStorageError("disk gone");
      },
      get: (key: string) => storage.get(key),
      exists: (key: string) => storage.exists(key),
      delete: (key: string) => storage.delete(key),
    };
    await expect(
      uploadReleaseArtifact(
        store,
        failing,
        releaseRef(),
        {
          artifactPath: "assets/outage.js",
          artifactType: "minified_asset",
          source: streamOf(bytesOf("var a = 1;")),
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_STORAGE_UNAVAILABLE" });
    expect(store.rows.size).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("cleans staging when the client disconnects mid-upload", async () => {
    const store = createMemoryStore();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadReleaseArtifact(
        store,
        storage,
        releaseRef(),
        {
          artifactPath: "assets/abort.js",
          artifactType: "minified_asset",
          source: streamOf(bytesOf("var a = 1;")),
          signal: controller.signal,
        },
        { maxFileBytes: 1024, stagingDir },
      ),
    ).rejects.toBeInstanceOf(DomainError);
    expect(store.insertCalls).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });

  it("stages then finalizes, cleaning staging when metadata is invalid", async () => {
    const store = createMemoryStore();
    const staged = await stageRawUpload(streamOf(bytesOf(VALID_MAP)), {
      maxFileBytes: 1024,
      stagingDir,
    });
    await expect(
      finalizeArtifactUpload(
        store,
        storage,
        releaseRef(),
        staged,
        { artifactPath: "../escape.map", artifactType: "source_map" },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" });
    expect(store.insertCalls).toBe(0);
    expect(await stagingIsEmpty(stagingDir)).toBe(true);
  });
});

describe("checkArtifactPreflight (memory store)", () => {
  it("returns upload/exists/conflict per artifact", async () => {
    const store = createMemoryStore();
    const known = bytesOf("var known = 1;");
    const knownHash = sha256Hex(known);
    const other = bytesOf("var other = 1;");
    const otherHash = sha256Hex(other);
    for (const [artifactPath, contentHash, sizeBytes] of [
      ["assets/known.js", knownHash, known.length],
      ["assets/other.js", otherHash, other.length],
    ] as const) {
      const inserted = await store.insert({
        releaseId: RELEASE_ID,
        artifactPath,
        storageKey: `${PROJECT_ID}/${RELEASE_ID}/${contentHash}`,
        contentHash,
        sizeBytes,
        artifactType: "minified_asset",
      });
      expect(inserted.id).toBeDefined();
    }

    const results = await checkArtifactPreflight(
      store,
      RELEASE_ID,
      {
        artifacts: [
          {
            artifactPath: "assets/new.js",
            artifactType: "minified_asset",
            contentHash: knownHash,
            sizeBytes: known.length,
          },
          {
            artifactPath: "assets/known.js",
            artifactType: "minified_asset",
            contentHash: knownHash,
            sizeBytes: known.length,
          },
          {
            artifactPath: "assets/other.js",
            artifactType: "minified_asset",
            contentHash: "0".repeat(64),
            sizeBytes: 8,
          },
        ],
      },
      { maxFileBytes: 1024 },
    );
    expect(results.map((r) => r.verdict)).toEqual([
      "upload",
      "exists",
      "conflict",
    ]);
    expect(results[0]?.artifactPath).toBe("assets/new.js");
  });

  it("canonicalizes Windows separators before lookup", async () => {
    const store = createMemoryStore();
    const results = await checkArtifactPreflight(
      store,
      RELEASE_ID,
      {
        artifacts: [
          {
            artifactPath: "dist\\assets\\app.js.map",
            artifactType: "source_map",
            contentHash: "a".repeat(64),
            sizeBytes: 128,
          },
        ],
      },
      { maxFileBytes: 1024 },
    );
    expect(results[0]?.artifactPath).toBe("dist/assets/app.js.map");
    expect(results[0]?.verdict).toBe("upload");
  });

  it("rejects oversized manifests, duplicates and invalid entries", async () => {
    const store = createMemoryStore();
    const entry = {
      artifactPath: "assets/a.js",
      artifactType: "minified_asset",
      contentHash: "a".repeat(64),
      sizeBytes: 8,
    };
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        { artifacts: [] },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        {
          artifacts: Array.from({ length: 501 }, (_, i) => ({
            ...entry,
            artifactPath: `assets/a${i}.js`,
          })),
        },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        { artifacts: [entry, { ...entry }] },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        {
          artifacts: [
            {
              ...entry,
              artifactPath: "../escape.js",
              contentHash: "b".repeat(64),
            },
          ],
        },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_PATH_INVALID" });
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        { artifacts: [{ ...entry, sizeBytes: 2048 }] },
        { maxFileBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects aggregate declarations over the cap with 413", async () => {
    const store = createMemoryStore();
    await expect(
      checkArtifactPreflight(
        store,
        RELEASE_ID,
        {
          artifacts: [
            {
              artifactPath: "assets/a.js",
              artifactType: "minified_asset",
              contentHash: "a".repeat(64),
              sizeBytes: 200 * 1024 * 1024,
            },
            {
              artifactPath: "assets/b.js",
              artifactType: "minified_asset",
              contentHash: "b".repeat(64),
              sizeBytes: 100 * 1024 * 1024,
            },
          ],
        },
        { maxFileBytes: 300 * 1024 * 1024 },
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });
});

describe("drizzleArtifactRecordStore", () => {
  it("is a function (real PG behavior covered by route integration)", () => {
    expect(typeof drizzleArtifactRecordStore).toBe("function");
  });
});
