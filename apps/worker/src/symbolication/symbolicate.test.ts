import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStorage,
  buildArtifactStorageKey,
} from "@replaybug/artifacts";
import { ReleaseRepo } from "@replaybug/db";
import type { Database } from "@replaybug/db";
import { symbolicateEvent } from "./symbolicate.js";
import {
  createWorkerTestDatabase,
  seedProject,
  type WorkerTestDatabase,
} from "../test-helpers.js";
import { beforeAll, afterAll } from "vitest";

/**
 * RS-08 symbolication unit + storage behavior (TDD, real PG + temp FS).
 *
 * - v3 fixture mapping (line/column/name/sourceRoot/relative-source)
 * - missing/partial mappings, malformed map, off-by-one columns
 * - URL query/origin stripping, Vite hashed paths, no network access
 * - SSRF: remote sourceMappingURL never read (http/https/file/ftp/data)
 * - no storage keys exposed; raw frames retained verbatim
 */

let testDb: WorkerTestDatabase;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function makeStorage(): Promise<{
  storage: LocalArtifactStorage;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "rs08-sym-"));
  tempDirs.push(dir);
  return { storage: new LocalArtifactStorage({ root: dir }), dir };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function putArtifact(
  storage: LocalArtifactStorage,
  projectId: string,
  releaseId: string,
  bytes: string | Buffer,
): Promise<{ storageKey: string; contentHash: string; sizeBytes: number }> {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const contentHash = sha256Hex(buffer.toString("utf8"));
  const storageKey = buildArtifactStorageKey(projectId, releaseId, contentHash);
  await storage.put(
    storageKey,
    (async function* () {
      yield buffer;
    })(),
  );
  return { storageKey, contentHash, sizeBytes: buffer.byteLength };
}

async function seedReleaseWithArtifacts(
  db: Database,
  projectId: string,
  version: string,
  storage: LocalArtifactStorage,
  files: Array<{
    path: string;
    content: string;
    type: "source_map" | "minified_asset";
  }>,
): Promise<string> {
  const { row: release } = await ReleaseRepo.createRelease(db, {
    projectId,
    version,
  });
  for (const file of files) {
    const { storageKey, contentHash, sizeBytes } = await putArtifact(
      storage,
      projectId,
      release.id,
      file.content,
    );
    await ReleaseRepo.insertReleaseArtifact(db, {
      releaseId: release.id,
      artifactPath: file.path,
      storageKey,
      contentHash,
      sizeBytes,
      artifactType: file.type,
    });
  }
  return release.id;
}

function exceptionPayload(
  frames: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    values: [
      {
        type: "TypeError",
        value: "Cannot read properties of null",
        stacktrace: { frames },
        mechanism: { type: "generic", handled: false },
      },
    ],
  };
}

// Fixture: generated col 0 -> line 1 name init; gen col 10 -> line 10 col 5 name render.
// Sources are Vite-style relative (`../src/...` from `assets/*.map`) so the
// worker resolves them against the map location to `src/app.ts`.
const NAMED_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: ["init", "render"],
  mappings: "AAAAA,UASKC",
});

// Off-by-one probe: gen col 0 -> line 1; gen col 1 -> line 20.
const OFF_BY_ONE_MAP = JSON.stringify({
  version: 3,
  sources: ["src/a.ts"],
  names: [],
  mappings: "AAAA,CAmBA",
});

describe("symbolicateEvent v3 fixtures", () => {
  it("maps line, column and name through a basic v3 map", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.0",
      storage,
      [
        {
          path: "assets/app.js",
          content: "minified\n//# sourceMappingURL=app.js.map\n",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );

    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.0",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );

    expect(result.status).toBe("mapped");
    expect(result.mappedFrameCount).toBe(1);
    expect(result.rawFrames).toHaveLength(1);
    expect(result.mappedFrames).toHaveLength(1);
    const mapped = result.mappedFrames[0];
    expect(mapped?.mapped).toBe(true);
    // Display col 11 -> generated 10 -> original line 10 col 5 (display 6) name render.
    expect(mapped?.line).toBe(10);
    expect(mapped?.column).toBe(6);
    expect(mapped?.function).toBe("render");
    expect(mapped?.name).toBe("render");
    expect(mapped?.source).toBe("src/app.ts");
    expect(mapped?.inApplication).toBe(true);
  });

  it("resolves sourceRoot and relative sources", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    const rootedMap = JSON.stringify({
      version: 3,
      file: "app.js",
      sourceRoot: "/the/root",
      sources: ["app.ts"],
      names: [],
      mappings: "AAAA",
    });
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.1",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: rootedMap, type: "source_map" },
      ],
    );

    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.1",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "f",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("mapped");
    expect(result.mappedFrames[0]?.source).toBe("/the/root/app.ts");
  });

  it("applies display-to-generated column conversion (off-by-one)", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.2",
      storage,
      [
        {
          path: "a.js",
          content: "x\n//# sourceMappingURL=a.js.map",
          type: "minified_asset",
        },
        { path: "a.js.map", content: OFF_BY_ONE_MAP, type: "source_map" },
      ],
    );

    // Display col 1 -> generated 0 -> original line 1.
    const first = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.2",
        payload: exceptionPayload([
          {
            filename: "https://example.com/a.js",
            function: "f",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(first.mappedFrames[0]?.line).toBe(1);

    // Display col 2 -> generated 1 -> original line 20. A missing -1
    // conversion would map display 1 straight to generated 1 (line 20).
    const second = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.2",
        payload: exceptionPayload([
          {
            filename: "https://example.com/a.js",
            function: "f",
            lineno: 1,
            colno: 2,
            in_app: true,
          },
        ]),
      },
    );
    expect(second.mappedFrames[0]?.line).toBe(20);
  });

  it("strips origin and query from generated URLs and keeps Vite hashed paths", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.3",
      storage,
      [
        {
          path: "assets/index-C8bf2.js",
          content: "x\n//# sourceMappingURL=index-C8bf2.js.map",
          type: "minified_asset",
        },
        {
          path: "assets/index-C8bf2.js.map",
          content: NAMED_MAP,
          type: "source_map",
        },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.3",
        payload: exceptionPayload([
          {
            filename:
              "https://cdn.example.com/assets/index-C8bf2.js?cache=1#frag",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("mapped");
    expect(result.mappedFrames[0]?.source).toBe("src/app.ts");
  });

  it("returns partially_mapped when only some frames resolve", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.4",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.4",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
          {
            filename: "https://example.com/assets/missing.js",
            function: "b",
            lineno: 5,
            colno: 5,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("partially_mapped");
    expect(result.mappedFrameCount).toBe(1);
    expect(result.mappedFrames[0]?.mapped).toBe(true);
    expect(result.mappedFrames[1]?.mapped).toBe(false);
    // Unmapped frames keep raw coordinates, never fabricated.
    expect(result.mappedFrames[1]?.filename).toBe(
      "https://example.com/assets/missing.js",
    );
  });

  it("returns map_not_found when the release has no suitable map", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.5",
      storage,
      [
        {
          path: "assets/other.js",
          content: "var x=1;\n",
          type: "minified_asset",
        },
        { path: "assets/other.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.5",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("map_not_found");
    expect(result.mappedFrameCount).toBe(0);
    expect(result.mappedFrames[0]?.mapped).toBe(false);
  });

  it("returns invalid_map for a malformed legacy map without crashing", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.6",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        {
          path: "assets/app.js.map",
          content: '{"version":2,"sources":[],"mappings":""}',
          type: "source_map",
        },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@1.0.6",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("invalid_map");
    expect(result.mappedFrameCount).toBe(0);
    // Raw frames retained verbatim.
    expect(result.rawFrames[0]?.filename).toBe(
      "https://example.com/assets/app.js",
    );
  });

  it("returns no_release when the event carries no release", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: null,
        payload: exceptionPayload([
          {
            filename: "https://example.com/a.js",
            function: "f",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("no_release");
    expect(result.mappedFrameCount).toBe(0);
  });

  it("returns release_not_found for an unregistered version (exact match, no cross-project)", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    const other = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      other.projectId,
      "web@9.9.9",
      storage,
      [{ path: "a.js", content: "x", type: "minified_asset" }],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@9.9.9",
        payload: exceptionPayload([
          {
            filename: "https://example.com/a.js",
            function: "f",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("release_not_found");
  });

  it("returns storage_unavailable when blob reads fail (no crash)", async () => {
    const project = await seedProject(testDb.client);
    const failingStorage = {
      async get(): Promise<never> {
        const { ArtifactStorageError } = await import("@replaybug/artifacts");
        throw new ArtifactStorageError("disk gone");
      },
    };
    // Seed release + artifact rows against a working storage, then
    // symbolicate with a failing storage to simulate an outage.
    const { storage } = await makeStorage();
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@1.0.7",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const result = await symbolicateEvent(
      // biome-ignore lint: test injects a failing storage on purpose
      { db: testDb.client.db, storage: failingStorage as never },
      {
        projectId: project.projectId,
        release: "web@1.0.7",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "f",
            lineno: 1,
            colno: 1,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("storage_unavailable");
    expect(result.mappedFrameCount).toBe(0);
  });

  it("never fetches remote sourceMappingURL values (SSRF matrix)", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    const remotes = [
      "https://evil.example/x.map",
      "http://evil.example/x.map",
      "file:///etc/passwd",
      "ftp://evil.example/x.map",
      "data:application/json,{}",
    ];
    for (const [index, remote] of remotes.entries()) {
      const version = `web@ssrf-${index}`;
      await seedReleaseWithArtifacts(
        testDb.client.db,
        project.projectId,
        version,
        storage,
        [
          {
            path: "assets/app.js",
            content: `var a=1;\n//# sourceMappingURL=${remote}\n`,
            type: "minified_asset",
          },
        ],
      );
      const result = await symbolicateEvent(
        { db: testDb.client.db, storage },
        {
          projectId: project.projectId,
          release: version,
          payload: exceptionPayload([
            {
              filename: "https://example.com/assets/app.js",
              function: "f",
              lineno: 1,
              colno: 1,
              in_app: true,
            },
          ]),
        },
      );
      // No sibling map exists and the remote must not be fetched: the
      // outcome is map_not_found, never a network read.
      expect(result.status).toBe("map_not_found");
    }
  });

  it("uses the asset trailing sourceMappingURL only when it is a relative local reference", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@rel-1",
      storage,
      [
        {
          path: "static/chunk.js",
          content: "var z=3;\n//# sourceMappingURL=maps/chunk.js.map\n",
          type: "minified_asset",
        },
        {
          path: "static/maps/chunk.js.map",
          content: NAMED_MAP,
          type: "source_map",
        },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@rel-1",
        payload: exceptionPayload([
          {
            filename: "https://example.com/static/chunk.js",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("mapped");
  });

  it("proves correspondence for non-sibling maps via the map file field only", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    const hintedMap = JSON.stringify({
      version: 3,
      file: "../bundle-lazy.js",
      sources: ["../../src/app.ts"],
      names: ["init", "render"],
      mappings: "AAAAA,UASKC",
    });
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@hint-1",
      storage,
      [
        {
          path: "static/bundle-lazy.js",
          content: "var y=2;\n",
          type: "minified_asset",
        },
        {
          path: "static/maps/bundle.js.map",
          content: hintedMap,
          type: "source_map",
        },
        {
          path: "static/other.js.map",
          content: JSON.stringify({
            version: 3,
            sources: ["src/decoy.ts"],
            names: [],
            mappings: "AAAA",
          }),
          type: "source_map",
        },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@hint-1",
        payload: exceptionPayload([
          {
            filename: "https://example.com/static/bundle-lazy.js",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("mapped");
    expect(result.mappedFrames[0]?.source).toBe("src/app.ts");
  });

  it("never fuzzy-matches an unrelated same-release map", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@hint-2",
      storage,
      [
        {
          path: "static/bundle-lazy.js",
          content: "var y=2;\n",
          type: "minified_asset",
        },
        {
          path: "static/other.js.map",
          content: JSON.stringify({
            version: 3,
            sources: ["src/decoy.ts"],
            names: [],
            mappings: "AAAA",
          }),
          type: "source_map",
        },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@hint-2",
        payload: exceptionPayload([
          {
            filename: "https://example.com/static/bundle-lazy.js",
            function: "a",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );
    expect(result.status).toBe("map_not_found");
    expect(result.mappedFrameCount).toBe(0);
  });

  it("never exposes storage keys and retains raw frames verbatim", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@leak-1",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@leak-1",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "origFn",
            lineno: 1,
            colno: 11,
            in_app: true,
          },
        ]),
      },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /storageKey|storage_key|contentHash|content_hash/,
    );
    expect(result.rawFrames[0]).toMatchObject({
      filename: "https://example.com/assets/app.js",
      function: "origFn",
      lineno: 1,
      colno: 11,
    });
  });

  it("ignores client-submitted mapped fields (worker enrichment only)", async () => {
    const { storage } = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedReleaseWithArtifacts(
      testDb.client.db,
      project.projectId,
      "web@client-1",
      storage,
      [
        {
          path: "assets/app.js",
          content: "x\n//# sourceMappingURL=app.js.map",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const result = await symbolicateEvent(
      { db: testDb.client.db, storage },
      {
        projectId: project.projectId,
        release: "web@client-1",
        payload: exceptionPayload([
          {
            filename: "https://example.com/assets/app.js",
            function: "evil",
            lineno: 1,
            colno: 11,
            in_app: true,
            mapped: true,
            source: "src/evil.ts",
            symbolication: { status: "mapped" },
          },
        ]),
      },
    );
    // Client lies are ignored: the worker recomputes from raw coordinates.
    expect(result.mappedFrames[0]?.source).toBe("src/app.ts");
    expect(result.rawFrames[0]?.filename).toBe(
      "https://example.com/assets/app.js",
    );
  });
});
