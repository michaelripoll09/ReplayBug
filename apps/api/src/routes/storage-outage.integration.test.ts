import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStorageError,
  LocalArtifactStorage,
  type ArtifactPutResult,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import type { DbClient } from "@replaybug/db";
import { processEvent } from "../../../worker/src/processors/process-event.js";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

/**
 * RS-12 storage-outage integration (real PG + real FS temp dir + the real
 * worker `processEvent` path + real HTTP incl. SSE).
 *
 * A controllable `ArtifactStorage` double simulates a full blob-store
 * outage and the subsequent recovery. While the store is down:
 * - ingest still accepts batches (202) and the outbox row is durable;
 * - the worker still processes events (raw fallback, `storage_unavailable`,
 *   no poison, issues are still created);
 * - issues/issues-detail/event-detail dashboard reads and the SSE stream
 *   keep working;
 * - artifact upload fails safe with 503 + `ARTIFACT_STORAGE_UNAVAILABLE`
 *   and stores no row.
 * After recovery, uploading the maps and ingesting a new event yields
 * genuinely `mapped` events again.
 */

const PASSWORD = "TestPass123!";
const ORIGIN = "https://outage.example.com";
const MINIFIED = "var a=1;\n//# sourceMappingURL=app.js.map\n";
const NAMED_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: ["init", "render"],
  mappings: "AAAAA,UASKC",
});

class ToggleStorage implements ArtifactStorage {
  readonly root: string;
  available = false;
  private readonly inner: LocalArtifactStorage;

  constructor(root: string) {
    this.inner = new LocalArtifactStorage({ root });
    this.root = this.inner.root;
  }

  private guard(): void {
    if (!this.available) {
      throw new ArtifactStorageError("simulated storage outage");
    }
  }

  async put(
    key: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<ArtifactPutResult> {
    this.guard();
    return this.inner.put(key, source);
  }

  async get(key: string): Promise<Readable> {
    this.guard();
    return this.inner.get(key);
  }

  async exists(key: string): Promise<boolean> {
    this.guard();
    return this.inner.exists(key);
  }

  async delete(key: string): Promise<boolean> {
    this.guard();
    return this.inner.delete(key);
  }
}

function frame(filename: string): Record<string, unknown> {
  return {
    filename,
    function: "a",
    lineno: 1,
    colno: 11,
    in_app: true,
  };
}

function makeBatch(
  release: string,
  clientEventId: string,
): Record<string, unknown> {
  return {
    protocol_version: 1,
    sdk_name: "@replaybug/sdk",
    sdk_version: "0.2.0",
    session: {
      sdk_session_id: `outage-${clientEventId}`,
      browser: {
        name: "chromium",
        version: "120.0",
        os_name: "Windows",
        os_version: "11",
        device_type: "desktop",
        viewport_width: 1280,
        viewport_height: 720,
      },
      initial_url: `${ORIGIN}/`,
      environment: "production",
      release,
    },
    events: [
      {
        event_id: clientEventId,
        sequence_number: 0,
        event_type: "exception",
        timestamp: new Date().toISOString(),
        payload: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of null (reading 'total')",
              stacktrace: { frames: [frame(`${ORIGIN}/assets/app.js`)] },
              mechanism: { type: "generic", handled: false },
            },
          ],
        },
      },
    ],
  };
}

function encodeMultipart(
  boundary: string,
  artifactPath: string,
  artifactType: string,
  bytes: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="artifactPath"\r\n\r\n${artifactPath}\r\n`,
      "utf8",
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="artifactType"\r\n\r\n${artifactType}\r\n`,
      "utf8",
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}

describe("RS-12 storage outage and recovery (real PG + FS + worker path)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let storage: ToggleStorage;
  let storageRoot = "";
  let baseUrl = "";

  beforeAll(async () => {
    dbClient = createTestDbClient();
    storageRoot = await mkdtemp(join(tmpdir(), "rs12-outage-storage-"));
    storage = new ToggleStorage(storageRoot);
    app = await buildApp({
      config: testApiConfig(),
      dbClient,
      artifactStorage: storage,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("outage test server did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
    storage.available = true;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  async function signup(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: PASSWORD, name: "Outage Tester" },
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

  async function fixture(tag: string): Promise<{
    cookie: string;
    projectId: string;
    publicKey: string;
    token: string;
  }> {
    const stamp = `${Date.now()}-${tag}`;
    const cookie = await signup(`outage-${stamp}@example.com`);
    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: `Outage WS ${stamp}` },
    });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json() as { id: string };
    const projRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws.id}/projects`,
      headers: { cookie },
      payload: { name: `Outage Proj ${stamp}` },
    });
    expect(projRes.statusCode).toBe(201);
    const created = projRes.json() as {
      project: { id: string };
      bootstrap: { key: string };
    };
    const originRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${created.project.id}/origins`,
      headers: { cookie },
      payload: { origin: ORIGIN },
    });
    expect(originRes.statusCode).toBe(201);
    const tokenRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${created.project.id}/secret-tokens`,
      headers: { cookie },
      payload: { name: "outage-ci" },
    });
    expect(tokenRes.statusCode).toBe(201);
    const tokenBody = tokenRes.json() as { token: string };
    return {
      cookie,
      projectId: created.project.id,
      publicKey: created.bootstrap.key,
      token: tokenBody.token,
    };
  }

  async function createRelease(token: string, version: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/cli/releases",
      headers: { authorization: `Bearer ${token}` },
      payload: { version },
    });
    expect([200, 201]).toContain(res.statusCode);
  }

  async function upload(
    token: string,
    version: string,
    artifactPath: string,
    artifactType: string,
    bytes: Uint8Array,
  ): Promise<{ statusCode: number; body: unknown }> {
    const boundary = `rs12-${randomUUID()}`;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/cli/releases/${encodeURIComponent(version)}/artifacts`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: encodeMultipart(boundary, artifactPath, artifactType, bytes),
    });
    let body: unknown;
    try {
      body = res.json() as unknown;
    } catch {
      body = null;
    }
    return { statusCode: res.statusCode, body };
  }

  async function ingest(
    publicKey: string,
    batch: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: unknown }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: { "x-replaybug-key": publicKey, origin: ORIGIN },
      payload: batch,
    });
    return { statusCode: res.statusCode, body: res.json() as unknown };
  }

  interface SymbolicationView {
    status: string;
    mappedFrameCount: number;
    mappedSource: string | null;
  }

  async function readSymbolication(
    eventId: string,
  ): Promise<SymbolicationView> {
    const rows = await dbClient.pool.query(
      `SELECT symbolication_json FROM events WHERE id = $1`,
      [eventId],
    );
    const value = rows.rows[0]?.symbolication_json as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("symbolication_json is not an object");
    }
    const record = value as Record<string, unknown>;
    const mapped = Array.isArray(record["mappedFrames"])
      ? (record["mappedFrames"] as unknown[])
      : [];
    const head = mapped[0];
    const source =
      typeof head === "object" && head !== null && !Array.isArray(head)
        ? (head as Record<string, unknown>)["source"]
        : null;
    return {
      status: typeof record["status"] === "string" ? record["status"] : "",
      mappedFrameCount:
        typeof record["mappedFrameCount"] === "number"
          ? record["mappedFrameCount"]
          : -1,
      mappedSource: typeof source === "string" ? source : null,
    };
  }

  it("outage: ingest/outbox/worker/issues/SSE pass raw, upload 503s, recovery remaps", async () => {
    const f = await fixture("matrix");
    const version = `web@outage-${Date.now().toString(36)}`;
    await createRelease(f.token, version);

    // Healthy baseline: the release's maps upload cleanly BEFORE the outage
    // so the worker has registered artifact rows whose blobs go unreadable.
    const assetUp = await upload(
      f.token,
      version,
      "assets/app.js",
      "minified_asset",
      Buffer.from(MINIFIED, "utf8"),
    );
    expect(assetUp.statusCode).toBe(201);
    const mapUp = await upload(
      f.token,
      version,
      "assets/app.js.map",
      "source_map",
      Buffer.from(NAMED_MAP, "utf8"),
    );
    expect(mapUp.statusCode).toBe(201);

    // The outage starts: every blob read fails from here on.
    storage.available = false;

    // Ingest still accepts while storage is down; the outbox row is durable.
    const clientEventId = randomUUID();
    const accepted = await ingest(
      f.publicKey,
      makeBatch(version, clientEventId),
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toMatchObject({ accepted: 1 });
    const eventRows = await dbClient.pool.query(
      `SELECT id, processing_state FROM events
       WHERE project_id = $1 AND client_event_id = $2`,
      [f.projectId, clientEventId],
    );
    expect(eventRows.rows).toHaveLength(1);
    const eventId = eventRows.rows[0].id as string;
    expect(eventRows.rows[0].processing_state).toBe("pending");
    const outboxRows = await dbClient.pool.query(
      `SELECT event_id, dispatched_at FROM event_processing_outbox WHERE event_id = $1`,
      [eventId],
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0].dispatched_at).toBeNull();

    // The real worker path degrades to raw (no poison, issue still created).
    const outcome = await processEvent({ db: dbClient.db, storage }, eventId);
    expect(outcome.status).toBe("processed");
    const degraded = await readSymbolication(eventId);
    expect(degraded.status).toBe("storage_unavailable");
    expect(degraded.mappedFrameCount).toBe(0);
    if (outcome.status !== "processed" || outcome.issueId === null) {
      throw new Error("outage event produced no issue");
    }

    // Dashboard reads keep working on the raw enrichment.
    const issuesRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${f.projectId}/issues`,
      headers: { cookie: f.cookie },
    });
    expect(issuesRes.statusCode).toBe(200);
    expect(JSON.stringify(issuesRes.json())).toContain(outcome.issueId);
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${outcome.issueId}`,
      headers: { cookie: f.cookie },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(JSON.stringify(detailRes.json())).toContain(
      "Cannot read properties of null",
    );
    const eventRes = await app.inject({
      method: "GET",
      url: `/api/v1/events/${eventId}`,
      headers: { cookie: f.cookie },
    });
    expect(eventRes.statusCode).toBe(200);
    const eventBody = eventRes.json() as {
      diagnostic: { symbolicationStatus: string };
    };
    expect(eventBody.diagnostic.symbolicationStatus).toBe(
      "storage_unavailable",
    );
    // Raw frames stay readable through the dashboard event view.
    expect(JSON.stringify(eventRes.json())).toContain("assets/app.js");

    // The realtime stream still connects during the outage.
    const controller = new AbortController();
    const stream = await fetch(
      `${baseUrl}/api/v1/projects/${f.projectId}/events/stream`,
      { headers: { cookie: f.cookie }, signal: controller.signal },
    );
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
    } finally {
      controller.abort();
      await stream.body?.cancel().catch(() => undefined);
    }

    // Upload fails safe with 503 and stores no artifact row.
    const failed = await upload(
      f.token,
      version,
      "assets/other.js.map",
      "source_map",
      Buffer.from(NAMED_MAP, "utf8"),
    );
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toMatchObject({
      code: "ARTIFACT_STORAGE_UNAVAILABLE",
    });
    const artifactRows = await dbClient.pool.query(
      `SELECT artifact_path FROM release_artifacts ra
       JOIN releases r ON r.id = ra.release_id
       WHERE r.project_id = $1`,
      [f.projectId],
    );
    const paths = (artifactRows.rows as Array<{ artifact_path: string }>).map(
      (row) => row.artifact_path,
    );
    expect(paths).not.toContain("assets/other.js.map");

    // Recovery: NEW events map genuinely again (blobs readable once more).
    storage.available = true;

    const secondEventId = randomUUID();
    const second = await ingest(f.publicKey, makeBatch(version, secondEventId));
    expect(second.statusCode).toBe(200);
    const secondRows = await dbClient.pool.query(
      `SELECT id FROM events WHERE project_id = $1 AND client_event_id = $2`,
      [f.projectId, secondEventId],
    );
    const recoveredId = secondRows.rows[0].id as string;
    const recovered = await processEvent(
      { db: dbClient.db, storage },
      recoveredId,
    );
    expect(recovered.status).toBe("processed");
    const remapped = await readSymbolication(recoveredId);
    expect(remapped.status).toBe("mapped");
    expect(remapped.mappedFrameCount).toBe(1);
    expect(remapped.mappedSource).toBe("src/app.ts");

    // The outage-era issue keeps its honest raw status (history is kept).
    expect((await readSymbolication(eventId)).status).toBe(
      "storage_unavailable",
    );
  });
});
