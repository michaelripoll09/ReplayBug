import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalArtifactStorage,
  buildArtifactStorageKey,
} from "@replaybug/artifacts";
import { ReleaseRepo, type Database } from "@replaybug/db";
import { processEvent } from "./process-event.js";
import {
  createWorkerTestDatabase,
  exceptionPayload,
  insertTestEvent,
  readEventRow,
  readIssuesByProject,
  seedProject,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * RS-09 mapped-fingerprint worker integration (real PostgreSQL + temp FS).
 *
 * Critical scenario: Release A `assets/app-AAA.js:1:100` and Release B
 * `assets/app-BBB.js:1:928` both mapping to
 * `src/features/checkout/CheckoutButton.tsx:84` with the same exception
 * class/message yield the SAME fingerprint and the SAME issue — the raw
 * generated filename/hash no longer dominates grouping. Release stays
 * excluded; the raw ingest payload is never overwritten.
 */

let testDb: WorkerTestDatabase;
beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeStorage(): Promise<LocalArtifactStorage> {
  const dir = await mkdtemp(join(tmpdir(), "rs09-fp-"));
  tempDirs.push(dir);
  return new LocalArtifactStorage({ root: dir });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Single-segment v3 map: any column on generated line 1 resolves to the
// original line 84 col 0 (display col 1). `AAmFA` = genCol 0, source 0,
// origLine delta 83 (0-based 83 = display 84), origCol 0. Sources are
// map-relative (`../src/...` from `assets/*.map`) so the worker resolves
// them to `src/...` (RS-08 `mapUrl` behavior).
const MAP_CHECKOUT = JSON.stringify({
  version: 3,
  sources: ["../src/features/checkout/CheckoutButton.tsx"],
  names: [],
  mappings: "AAmFA",
});

const MAP_CART = JSON.stringify({
  version: 3,
  sources: ["../src/features/cart/CartView.tsx"],
  names: [],
  mappings: "AAmFA",
});

async function seedRelease(
  db: Database,
  storage: LocalArtifactStorage,
  projectId: string,
  version: string,
  files: Array<{
    path: string;
    content: string;
    type: "source_map" | "minified_asset";
  }>,
): Promise<void> {
  const { row: release } = await ReleaseRepo.createRelease(db, {
    projectId,
    version,
  });
  for (const file of files) {
    const buffer = Buffer.from(file.content, "utf8");
    const contentHash = sha256Hex(file.content);
    const storageKey = buildArtifactStorageKey(
      projectId,
      release.id,
      contentHash,
    );
    await storage.put(
      storageKey,
      (async function* () {
        yield buffer;
      })(),
    );
    await ReleaseRepo.insertReleaseArtifact(db, {
      releaseId: release.id,
      artifactPath: file.path,
      storageKey,
      contentHash,
      sizeBytes: buffer.byteLength,
      artifactType: file.type,
    });
  }
}

const MESSAGE = "Cannot read properties of null (reading 'total')";

function payloadFor(asset: string, colno: number): Record<string, unknown> {
  return exceptionPayload(MESSAGE, {
    frames: [
      {
        filename: `https://cdn.example.com/assets/${asset}`,
        function: "a",
        lineno: 1,
        colno,
        in_app: true,
      },
    ],
  });
}

async function readSymbolication(eventId: string): Promise<{
  status: string;
  mappedFrameCount: number;
  mappedFrames: Array<Record<string, unknown>>;
} | null> {
  const rows = await testDb.client.pool.query(
    `SELECT symbolication_json FROM events WHERE id = $1`,
    [eventId],
  );
  const value = rows.rows[0]?.symbolication_json as unknown;
  if (value === null || value === undefined) {
    return null;
  }
  return value as {
    status: string;
    mappedFrameCount: number;
    mappedFrames: Array<Record<string, unknown>>;
  };
}

describe("mapped fingerprinting across releases (RS-09)", () => {
  it("groups app-AAA.js:1:100 and app-BBB.js:1:928 into one issue via CheckoutButton.tsx:84", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(testDb.client.db, storage, project.projectId, "web@aaa", [
      {
        path: "assets/app-AAA.js",
        content: "var a=1;\n",
        type: "minified_asset",
      },
      {
        path: "assets/app-AAA.js.map",
        content: MAP_CHECKOUT,
        type: "source_map",
      },
    ]);
    await seedRelease(testDb.client.db, storage, project.projectId, "web@bbb", [
      {
        path: "assets/app-BBB.js",
        content: "var b=2;\n",
        type: "minified_asset",
      },
      {
        path: "assets/app-BBB.js.map",
        content: MAP_CHECKOUT,
        type: "source_map",
      },
    ]);

    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app-AAA.js", 100),
      release: "web@aaa",
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app-BBB.js", 928),
      release: "web@bbb",
    });

    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);

    const firstEvent = await readEventRow(testDb.client, first.eventId);
    const secondEvent = await readEventRow(testDb.client, second.eventId);
    expect(firstEvent?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondEvent?.fingerprint).toBe(firstEvent?.fingerprint);

    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(issues[0]?.fingerprint_signature).toContain(
      "src/features/checkout/CheckoutButton.tsx:84",
    );
    expect(issues[0]?.fingerprint_signature).not.toContain("app-AAA");
    expect(issues[0]?.fingerprint_signature).not.toContain("app-BBB");

    expect((await readSymbolication(first.eventId))?.status).toBe("mapped");
    expect((await readSymbolication(second.eventId))?.status).toBe("mapped");
  });

  it("separates different original source locations", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@checkout",
      [
        {
          path: "assets/app.js",
          content: "var a=1;\n",
          type: "minified_asset",
        },
        {
          path: "assets/app.js.map",
          content: MAP_CHECKOUT,
          type: "source_map",
        },
      ],
    );
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@cart",
      [
        {
          path: "assets/app.js",
          content: "var a=1;\n",
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: MAP_CART, type: "source_map" },
      ],
    );

    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app.js", 100),
      release: "web@checkout",
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app.js", 100),
      release: "web@cart",
    });

    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);

    const firstEvent = await readEventRow(testDb.client, first.eventId);
    const secondEvent = await readEventRow(testDb.client, second.eventId);
    expect(secondEvent?.fingerprint).not.toBe(firstEvent?.fingerprint);
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(2);
  });

  it("is deterministic for partial mapping (mapped + raw fallback)", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@partial",
      [
        {
          path: "assets/app.js",
          content: "var a=1;\n",
          type: "minified_asset",
        },
        {
          path: "assets/app.js.map",
          content: MAP_CHECKOUT,
          type: "source_map",
        },
      ],
    );

    function partialPayload(): Record<string, unknown> {
      return exceptionPayload(MESSAGE, {
        frames: [
          {
            filename: "https://cdn.example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 100,
            in_app: true,
          },
          {
            filename: "https://cdn.example.com/assets/missing.js",
            function: "b",
            lineno: 5,
            colno: 5,
            in_app: true,
          },
        ],
      });
    }

    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: partialPayload(),
      release: "web@partial",
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: partialPayload(),
      release: "web@partial",
    });

    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);

    const firstEvent = await readEventRow(testDb.client, first.eventId);
    const secondEvent = await readEventRow(testDb.client, second.eventId);
    expect(secondEvent?.fingerprint).toBe(firstEvent?.fingerprint);
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(issues[0]?.fingerprint_signature).toContain("CheckoutButton.tsx:84");
    expect((await readSymbolication(first.eventId))?.status).toBe(
      "partially_mapped",
    );
  });

  it("lets an explicit custom fingerprint override mapped selection", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@custom",
      [
        {
          path: "assets/app.js",
          content: "var a=1;\n",
          type: "minified_asset",
        },
        {
          path: "assets/app.js.map",
          content: MAP_CHECKOUT,
          type: "source_map",
        },
      ],
    );

    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("first distinct message", {
        fingerprint: ["checkout", "payment-step"],
        frames: [
          {
            filename: "https://cdn.example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 100,
            in_app: true,
          },
        ],
      }),
      release: "web@custom",
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("second distinct message", {
        fingerprint: ["checkout", "payment-step"],
        frames: [
          {
            filename: "https://cdn.example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 100,
            in_app: true,
          },
        ],
      }),
      release: "web@custom",
    });

    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);

    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(issues[0]?.fingerprint_signature).toContain('"custom"');
    expect((await readSymbolication(first.eventId))?.status).toBe("mapped");
  });

  it("keeps the no-release raw path deterministic", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app-AAA.js", 100),
      release: null,
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: payloadFor("app-AAA.js", 100),
      release: null,
    });

    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);

    const firstEvent = await readEventRow(testDb.client, first.eventId);
    const secondEvent = await readEventRow(testDb.client, second.eventId);
    expect(secondEvent?.fingerprint).toBe(firstEvent?.fingerprint);
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect((await readSymbolication(first.eventId))?.status).toBe("no_release");
  });
});
