import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ARTIFACT_MAX_FILE_BYTES } from "./config.js";
import {
  ArtifactConfigError,
  ArtifactKeyError,
  ArtifactNotFoundError,
  ArtifactStorageError,
  ArtifactTooLargeError,
} from "./errors.js";
import { readArtifactToBuffer } from "./load.js";
import { LocalArtifactStorage } from "./local-storage.js";
import { buildArtifactStorageKey } from "./storage-keys.js";

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";
const RELEASE_ID = "223e4567-e89b-12d3-a456-426614174001";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "replaybug-artifacts-"));
  roots.push(root);
  return root;
}

async function makeStorage(): Promise<{
  storage: LocalArtifactStorage;
  root: string;
}> {
  const root = await makeRoot();
  return { storage: new LocalArtifactStorage({ root }), root };
}

function storageKeyFor(contentHash: string, releaseId = RELEASE_ID): string {
  return buildArtifactStorageKey(PROJECT_ID, releaseId, contentHash);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function tempEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.startsWith(".tmp-")) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

describe("constructor", () => {
  it("rejects unsafe roots instead of creating directories", async () => {
    expect(() => new LocalArtifactStorage({ root: "relative/path" })).toThrow(
      ArtifactConfigError,
    );
    expect(
      () => new LocalArtifactStorage({ root: path.parse(os.tmpdir()).root }),
    ).toThrow(ArtifactConfigError);
  });

  it("builds from the shared env contract", async () => {
    const root = await makeRoot();
    const storage = LocalArtifactStorage.fromEnv({
      REPLAYBUG_ARTIFACT_DIR: root,
    });
    expect(storage.root).toBe(path.resolve(root));
  });
});

describe("put/get round-trip", () => {
  it("stores bytes and returns hash + size", async () => {
    const { storage } = await makeStorage();
    const bytes = randomBytes(32 * 1024);
    const key = storageKeyFor(sha256(bytes));

    const result = await storage.put(key, Readable.from([bytes]));
    expect(result).toEqual({
      contentHash: sha256(bytes),
      sizeBytes: bytes.length,
    });

    const loaded = await collect(await storage.get(key));
    expect(loaded.equals(bytes)).toBe(true);
  });

  it("streams multi-chunk input without buffering the whole body", async () => {
    const { storage } = await makeStorage();
    const chunks = Array.from({ length: 16 }, () => randomBytes(4096));
    const whole = Buffer.concat(chunks);
    const key = storageKeyFor(sha256(whole));

    const result = await storage.put(
      key,
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    );
    expect(result.sizeBytes).toBe(whole.length);
    expect((await collect(await storage.get(key))).equals(whole)).toBe(true);
  });

  it("overwrites nothing on identical re-put and leaves no temp files", async () => {
    const { storage, root } = await makeStorage();
    const bytes = randomBytes(1024);
    const key = storageKeyFor(sha256(bytes));

    await storage.put(key, Readable.from([bytes]));
    const second = await storage.put(key, Readable.from([bytes]));
    expect(second.contentHash).toBe(sha256(bytes));
    expect(await tempEntries(root)).toEqual([]);
    expect((await collect(await storage.get(key))).equals(bytes)).toBe(true);
  });

  it("does not enforce REPLAYBUG_ARTIFACT_MAX_FILE_BYTES (RS-06 owns limits)", async () => {
    const { storage } = await makeStorage();
    const bytes = randomBytes(64);
    const key = storageKeyFor(sha256(bytes));
    // put() takes (key, source) only: byte limits are parsed in config for
    // the shared env contract but enforced by the RS-06 upload pipeline.
    const result = await storage.put(key, Readable.from([bytes]));
    expect(result.sizeBytes).toBe(bytes.length);
    expect(DEFAULT_ARTIFACT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("exists/delete", () => {
  it("reports presence and deletes exactly once", async () => {
    const { storage } = await makeStorage();
    const bytes = randomBytes(256);
    const key = storageKeyFor(sha256(bytes));

    expect(await storage.exists(key)).toBe(false);
    expect(await storage.delete(key)).toBe(false);

    await storage.put(key, Readable.from([bytes]));
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.delete(key)).toBe(true);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.delete(key)).toBe(false);
  });
});

describe("missing keys", () => {
  it("get throws ArtifactNotFoundError with the key attached", async () => {
    const { storage } = await makeStorage();
    const key = storageKeyFor(sha256(randomBytes(8)));
    const error = await storage.get(key).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ArtifactNotFoundError);
    expect((error as ArtifactNotFoundError).key).toBe(key);
  });
});

describe("adversarial keys", () => {
  it.each([
    ["dotdot", "../evil"],
    ["nested traversal", "a/../../evil"],
    ["absolute", "/etc/passwd"],
    ["backslash", "a\\evil"],
    ["empty", ""],
  ])("put rejects %s without touching the disk", async (_label, key) => {
    const { storage, root } = await makeStorage();
    const before = await readdir(root);
    await expect(
      storage.put(key, Readable.from([randomBytes(8)])),
    ).rejects.toBeInstanceOf(ArtifactKeyError);
    expect(await readdir(root)).toEqual(before);
    await expect(storage.get(key)).rejects.toBeInstanceOf(ArtifactKeyError);
    await expect(storage.exists(key)).rejects.toBeInstanceOf(ArtifactKeyError);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(ArtifactKeyError);
  });

  it("never writes outside the root for keys that resolve oddly", async () => {
    const { storage, root } = await makeStorage();
    const contentHash = "e".repeat(64);
    const key = `${PROJECT_ID}/${RELEASE_ID}/${contentHash}`;
    const escapedTarget = path.join(
      path.dirname(root),
      PROJECT_ID,
      RELEASE_ID,
      contentHash,
    );
    const bytes = randomBytes(32);
    await storage.put(key, Readable.from([bytes]));
    // A root escape would write this exact sibling target.
    await expect(stat(escapedTarget)).rejects.toMatchObject({ code: "ENOENT" });
    const st = await stat(path.join(root, PROJECT_ID, RELEASE_ID, contentHash));
    expect(st.size).toBe(bytes.length);
  });
});

describe("concurrent puts", () => {
  it("handles parallel puts to the same key", async () => {
    const { storage, root } = await makeStorage();
    const bytes = randomBytes(4096);
    const key = storageKeyFor(sha256(bytes));

    const results = await Promise.all(
      Array.from({ length: 8 }, () => storage.put(key, Readable.from([bytes]))),
    );
    for (const result of results) {
      expect(result.contentHash).toBe(sha256(bytes));
    }
    expect((await collect(await storage.get(key))).equals(bytes)).toBe(true);
    expect(await tempEntries(root)).toEqual([]);
  });

  it("handles parallel puts to distinct keys", async () => {
    const { storage, root } = await makeStorage();
    const payloads = Array.from({ length: 8 }, () => randomBytes(2048));
    await Promise.all(
      payloads.map((bytes) =>
        storage.put(storageKeyFor(sha256(bytes)), Readable.from([bytes])),
      ),
    );
    for (const bytes of payloads) {
      const loaded = await collect(
        await storage.get(storageKeyFor(sha256(bytes))),
      );
      expect(loaded.equals(bytes)).toBe(true);
    }
    expect(await tempEntries(root)).toEqual([]);
  });
});

describe("failure cleanup", () => {
  it("removes temp files and the partial target when the stream fails", async () => {
    const { storage, root } = await makeStorage();
    const key = storageKeyFor("f".repeat(64));
    const failing = Readable.from(
      (async function* () {
        yield randomBytes(16);
        yield randomBytes(16);
        throw new Error("boom-mid-stream");
      })(),
    );

    await expect(storage.put(key, failing)).rejects.toBeInstanceOf(
      ArtifactStorageError,
    );
    expect(await tempEntries(root)).toEqual([]);
    expect(await storage.exists(key)).toBe(false);
  });
});

describe("readArtifactToBuffer", () => {
  it("loads stored bytes", async () => {
    const { storage } = await makeStorage();
    const bytes = randomBytes(512);
    const key = storageKeyFor(sha256(bytes));
    await storage.put(key, Readable.from([bytes]));
    expect((await readArtifactToBuffer(storage, key)).equals(bytes)).toBe(true);
  });

  it("enforces the byte cap for source-map loading", async () => {
    const { storage } = await makeStorage();
    const bytes = randomBytes(1024);
    const key = storageKeyFor(sha256(bytes));
    await storage.put(key, Readable.from([bytes]));
    await expect(
      readArtifactToBuffer(storage, key, { maxBytes: 16 }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
  });

  it("propagates missing keys", async () => {
    const { storage } = await makeStorage();
    const key = storageKeyFor(sha256(randomBytes(8)));
    await expect(readArtifactToBuffer(storage, key)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
  });
});
