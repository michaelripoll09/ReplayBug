import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
 * RS-08 worker integration A–F + Block 5 concurrency regressions (TDD).
 *
 * Real PostgreSQL (isolated temp database) + temp FS (`LocalArtifactStorage`
 * rooted at a fresh temp dir per test). Pipeline order under test:
 * (A) preload immutable context → (B) symbolicate outside the tx →
 * (C) lock FOR UPDATE → (F) persist enrichment as JSONB alongside the
 * untouched ingest payload → grouping/aggregates/NOTIFY → commit.
 *
 * Fingerprint derivation stays RAW in RS-08 (RS-09 flips it): grouping
 * assertions below pin the raw behavior while enrichment is persisted.
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
  const dir = await mkdtemp(join(tmpdir(), "rs08-worker-"));
  tempDirs.push(dir);
  return new LocalArtifactStorage({ root: dir });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const NAMED_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: ["init", "render"],
  mappings: "AAAAA,UASKC",
});

const MINIFIED_WITH_SOURCEMAPPING =
  "var a=1;\n//# sourceMappingURL=app.js.map\n";

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

function minifiedPayload(): Record<string, unknown> {
  return exceptionPayload("Cannot read properties of null (reading 'total')", {
    frames: [
      {
        filename: "https://example.com/assets/app.js",
        function: "a",
        lineno: 1,
        colno: 11,
        in_app: true,
      },
    ],
  });
}

interface SymbolicationJson {
  status: string;
  rawFrames: unknown[];
  mappedFrames: unknown[];
  mappedFrameCount: number;
}

async function readSymbolication(
  eventId: string,
): Promise<SymbolicationJson | null> {
  const rows = await testDb.client.pool.query(
    `SELECT symbolication_json FROM events WHERE id = $1`,
    [eventId],
  );
  const value = rows.rows[0]?.symbolication_json as unknown;
  if (value === null || value === undefined) {
    return null;
  }
  return value as SymbolicationJson;
}

async function readPayload(eventId: string): Promise<unknown> {
  const rows = await testDb.client.pool.query(
    `SELECT payload_json FROM events WHERE id = $1`,
    [eventId],
  );
  return rows.rows[0]?.payload_json as unknown;
}

describe("worker symbolication integration (A–F)", () => {
  it("A: mapped event is stored processed with enrichment and raw intact", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@1.0.0",
      [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@1.0.0",
    });

    const outcome = await processEvent(
      { db: testDb.client.db, storage },
      eventId,
    );
    expect(outcome.status).toBe("processed");

    const event = await readEventRow(testDb.client, eventId);
    expect(event?.processing_state).toBe("processed");
    // Fingerprint stays RAW in RS-08: grouping uses the generated frame.
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const enrichment = await readSymbolication(eventId);
    expect(enrichment).not.toBeNull();
    expect(enrichment?.status).toBe("mapped");
    expect(enrichment?.mappedFrameCount).toBe(1);
    expect(enrichment?.rawFrames).toHaveLength(1);
    expect(enrichment?.mappedFrames).toHaveLength(1);
    const mapped = enrichment?.mappedFrames[0] as Record<string, unknown>;
    expect(mapped?.["mapped"]).toBe(true);
    expect(mapped?.["source"]).toBe("src/app.ts");
    expect(mapped?.["line"]).toBe(10);
    const serialized = JSON.stringify(enrichment);
    expect(serialized).not.toMatch(/storageKey|storage_key/);

    // Raw ingest payload is NEVER overwritten.
    const payload = (await readPayload(eventId)) as {
      values: Array<{ stacktrace: { frames: Array<{ filename: string }> } }>;
    };
    expect(payload.values[0]?.stacktrace.frames[0]?.filename).toBe(
      "https://example.com/assets/app.js",
    );
  });

  it("B: missing release degrades to raw processed with release_not_found", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@missing",
    });

    const outcome = await processEvent(
      { db: testDb.client.db, storage },
      eventId,
    );
    expect(outcome.status).toBe("processed");
    const enrichment = await readSymbolication(eventId);
    expect(enrichment?.status).toBe("release_not_found");
    expect(enrichment?.mappedFrameCount).toBe(0);
    const event = await readEventRow(testDb.client, eventId);
    expect(event?.processing_state).toBe("processed");
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("B2: event without release degrades to raw with no_release", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: null,
    });
    const outcome = await processEvent(
      { db: testDb.client.db, storage },
      eventId,
    );
    expect(outcome.status).toBe("processed");
    expect((await readSymbolication(eventId))?.status).toBe("no_release");
  });

  it("C: missing map degrades to raw processed with map_not_found", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@nomap",
      [
        {
          path: "assets/other.js",
          content: "var x=1;\n",
          type: "minified_asset",
        },
      ],
    );
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@nomap",
    });
    const outcome = await processEvent(
      { db: testDb.client.db, storage },
      eventId,
    );
    expect(outcome.status).toBe("processed");
    const enrichment = await readSymbolication(eventId);
    expect(enrichment?.status).toBe("map_not_found");
    expect(enrichment?.mappedFrameCount).toBe(0);
  });

  it("D: invalid legacy map degrades to raw processed with invalid_map (no crash)", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@badmap",
      [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        {
          path: "assets/app.js.map",
          content: '{"version":2,"sources":[],"mappings":""}',
          type: "source_map",
        },
      ],
    );
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@badmap",
    });
    const outcome = await processEvent(
      { db: testDb.client.db, storage },
      eventId,
    );
    expect(outcome.status).toBe("processed");
    expect((await readSymbolication(eventId))?.status).toBe("invalid_map");
  });

  it("E: storage outage degrades to raw processed with storage_unavailable (no poison)", async () => {
    const working = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      working,
      project.projectId,
      "web@outage",
      [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@outage",
    });
    const failingStorage = {
      async get(): Promise<never> {
        const { ArtifactStorageError } = await import("@replaybug/artifacts");
        throw new ArtifactStorageError("simulated outage");
      },
    };
    const outcome = await processEvent(
      { db: testDb.client.db, storage: failingStorage as never },
      eventId,
    );
    expect(outcome.status).toBe("processed");
    expect((await readSymbolication(eventId))?.status).toBe(
      "storage_unavailable",
    );
    // Retry of the same job is a no-op and keeps the first enrichment.
    const second = await processEvent(
      { db: testDb.client.db, storage: failingStorage as never },
      eventId,
    );
    expect(second.status).toBe("already-processed");
    expect((await readSymbolication(eventId))?.status).toBe(
      "storage_unavailable",
    );
  });

  it("F: custom fingerprint path is untouched by symbolication", async () => {
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
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("first distinct message", {
        fingerprint: ["checkout", "payment-step"],
        frames: [
          {
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 11,
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
            filename: "https://example.com/assets/app.js",
            function: "a",
            lineno: 1,
            colno: 11,
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
    // Enrichment is still persisted alongside the custom grouping.
    expect((await readSymbolication(first.eventId))?.status).toBe("mapped");
  });

  it("keeps raw grouping across releases in RS-08 (mapped grouping is RS-09)", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    for (const version of ["web@r1", "web@r2"]) {
      await seedRelease(testDb.client.db, storage, project.projectId, version, [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ]);
    }
    const first = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@r1",
    });
    const second = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@r2",
    });
    await processEvent({ db: testDb.client.db, storage }, first.eventId);
    await processEvent({ db: testDb.client.db, storage }, second.eventId);
    // Same raw frames group together even across releases (release is
    // excluded from the fingerprint); both are enriched as mapped.
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect((await readSymbolication(first.eventId))?.status).toBe("mapped");
    expect((await readSymbolication(second.eventId))?.status).toBe("mapped");
  });
});

describe("Block 5 concurrency regressions under the reorder", () => {
  it("processes the same event concurrently exactly once (symbolication outside the lock)", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@conc",
      [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const { eventId } = await insertTestEvent(testDb.client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: minifiedPayload(),
      release: "web@conc",
    });
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        processEvent({ db: testDb.client.db, storage }, eventId),
      ),
    );
    expect(outcomes.filter((o) => o.status === "processed")).toHaveLength(1);
    expect(
      outcomes.filter((o) => o.status === "already-processed"),
    ).toHaveLength(4);
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
    expect((await readSymbolication(eventId))?.status).toBe("mapped");
  });

  it("groups concurrent same-fingerprint events into one issue with enrichment", async () => {
    const storage = await makeStorage();
    const project = await seedProject(testDb.client);
    await seedRelease(
      testDb.client.db,
      storage,
      project.projectId,
      "web@conc2",
      [
        {
          path: "assets/app.js",
          content: MINIFIED_WITH_SOURCEMAPPING,
          type: "minified_asset",
        },
        { path: "assets/app.js.map", content: NAMED_MAP, type: "source_map" },
      ],
    );
    const events = [];
    for (let index = 0; index < 6; index++) {
      events.push(
        await insertTestEvent(testDb.client, {
          projectId: project.projectId,
          eventType: "exception",
          payload: minifiedPayload(),
          release: "web@conc2",
          sdkSessionId: `conc-session-${randomUUID()}-${index}`,
        }),
      );
    }
    const outcomes = await Promise.all(
      events.map((event) =>
        processEvent({ db: testDb.client.db, storage }, event.eventId),
      ),
    );
    expect(outcomes.every((o) => o.status === "processed")).toBe(true);
    const issues = await readIssuesByProject(testDb.client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(6);
    for (const event of events) {
      expect((await readSymbolication(event.eventId))?.status).toBe("mapped");
    }
  });
});
