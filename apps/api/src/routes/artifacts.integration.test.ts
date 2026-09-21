import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LocalArtifactStorage,
  ArtifactStorageError,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import { ReleaseRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

/**
 * RS-06 upload pipeline over HTTP (TDD): real PostgreSQL + real
 * filesystem temp dirs. Proves the full matrix — preflight
 * upload/exists/conflict, server-wins hashing, idempotent re-upload,
 * conflict no-overwrite, path-security with no file outside the
 * artifact root, limit edges, MIME policy, v3 map validation,
 * compensation (storage outage → 503, no row), staging cleanup on
 * every failure, and auth denials (public key, revoked,
 * cross-project).
 */

const PASSWORD = "TestPass123!";
const MiB = 1024 * 1024;
const MAX_FILE_BYTES = 2 * MiB;
const VERSION = "web@1.4.2";
const VALID_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: [],
  mappings: "AAAA",
});
const HELLO_SHA =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

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
  tag: string,
): Promise<{ projectId: string; bootstrapKey: string }> {
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: `Artifact WS ${tag}` },
  });
  expect(wsRes.statusCode).toBe(201);
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: `Artifact Proj ${tag}` },
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
): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/secret-tokens`,
    headers: { cookie },
    payload: { name: "ci-token" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

async function createRelease(
  app: AppInstance,
  token: string,
  version: string,
): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/cli/releases",
    headers: { authorization: `Bearer ${token}` },
    payload: { version },
  });
  expect([200, 201]).toContain(res.statusCode);
  const body = res.json() as { release: { id: string } };
  return { id: body.release.id };
}

interface MultipartFileSpec {
  fieldName: string;
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
}

function encodeMultipart(
  boundary: string,
  fields: Array<{ name: string; value: string }>,
  file: MultipartFileSpec | null,
  fileFirst: boolean,
): Buffer {
  const chunks: Buffer[] = [];
  const pushField = (name: string, value: string): void => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  };
  const pushFile = (spec: MultipartFileSpec): void => {
    const header =
      `--${boundary}\r\nContent-Disposition: form-data; name="${spec.fieldName}"; filename="${spec.filename}"\r\n` +
      (spec.contentType === null
        ? ""
        : `Content-Type: ${spec.contentType}\r\n`) +
      "\r\n";
    chunks.push(
      Buffer.from(header, "utf8"),
      Buffer.from(spec.bytes),
      Buffer.from("\r\n", "utf8"),
    );
  };
  if (fileFirst && file !== null) {
    pushFile(file);
  }
  for (const field of fields) {
    pushField(field.name, field.value);
  }
  if (!fileFirst && file !== null) {
    pushFile(file);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

interface UploadOptions {
  artifactPath?: string;
  artifactType?: string;
  bytes?: Uint8Array | undefined;
  contentType?: string | null;
  fileFirst?: boolean;
  omitFields?: boolean;
}

async function upload(
  app: AppInstance,
  token: string | null,
  version: string,
  options: UploadOptions = {},
) {
  const boundary = `rs06-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fields =
    options.omitFields === true
      ? []
      : [
          {
            name: "artifactPath",
            value: options.artifactPath ?? "assets/app.js.map",
          },
          {
            name: "artifactType",
            value: options.artifactType ?? "source_map",
          },
        ];
  const body = encodeMultipart(
    boundary,
    fields,
    options.bytes === undefined
      ? null
      : {
          fieldName: "file",
          // Fixed junk filename: the server must derive everything from
          // artifactPath, never from this value.
          filename: "upload.bin",
          contentType: options.contentType ?? "application/octet-stream",
          bytes: options.bytes,
        },
    options.fileFirst ?? false,
  );
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return app.inject({
    method: "POST",
    url: `/api/v1/cli/releases/${encodeURIComponent(version)}/artifacts`,
    headers,
    payload: body,
  });
}

async function preflight(
  app: AppInstance,
  token: string | null,
  version: string,
  artifacts: unknown,
) {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return app.inject({
    method: "POST",
    url: `/api/v1/cli/releases/${encodeURIComponent(version)}/artifacts/check`,
    headers,
    payload: { artifacts },
  });
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function readStorageBytes(
  storage: ArtifactStorage,
  key: string,
): Promise<Buffer> {
  const stream = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

interface Fixture {
  cookie: string;
  projectId: string;
  bootstrapKey: string;
  token: string;
  tokenId: string;
  releaseId: string;
}

describe("RS-06 artifact upload pipeline (real PG + real FS)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let storageRoot = "";
  let stagingDir = "";
  let storage: ArtifactStorage;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    storageRoot = await mkdtemp(join(tmpdir(), "rs06-http-storage-"));
    stagingDir = await mkdtemp(join(tmpdir(), "rs06-http-staging-"));
    storage = new LocalArtifactStorage({ root: storageRoot });
    app = await buildApp({
      config: testApiConfig({
        artifactDir: storageRoot,
        artifactMaxFileBytes: MAX_FILE_BYTES,
        artifactStagingDir: stagingDir,
      }),
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
    await rm(storageRoot, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  });

  async function fixture(tag: string): Promise<Fixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cookie = await signup(app, `art-${tag}-${stamp}@example.com`);
    const { projectId, bootstrapKey } = await createWorkspaceAndProject(
      app,
      cookie,
      `${tag} ${stamp}`,
    );
    const secret = await createSecretToken(app, cookie, projectId);
    const release = await createRelease(app, secret.token, VERSION);
    return {
      cookie,
      projectId,
      bootstrapKey,
      token: secret.token,
      tokenId: secret.id,
      releaseId: release.id,
    };
  }

  it("uploads a valid source map with 201 and the server hash", async () => {
    const f = await fixture("upload");
    const bytes = bytesOf(VALID_MAP);
    const res = await upload(app, f.token, VERSION, {
      artifactPath: "assets/app.js.map",
      artifactType: "source_map",
      bytes,
      contentType: "application/json",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      artifact: {
        id: string;
        artifactPath: string;
        artifactType: string;
        contentHash: string;
        sizeBytes: number;
        createdAt: string;
      };
      created: boolean;
    };
    expect(body.created).toBe(true);
    expect(body.artifact.artifactPath).toBe("assets/app.js.map");
    expect(body.artifact.artifactType).toBe("source_map");
    expect(body.artifact.contentHash).toBe(sha256Hex(bytes));
    expect(body.artifact.sizeBytes).toBe(bytes.length);
    expect(Object.keys(body.artifact).sort()).toEqual(
      [
        "artifactPath",
        "artifactType",
        "contentHash",
        "createdAt",
        "id",
        "sizeBytes",
      ].sort(),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(f.token);
    expect(serialized).not.toMatch(/storageKey|keyHash|secret/i);
    // Row + blob both exist.
    const row = await ReleaseRepo.findArtifactByReleaseAndPath(
      dbClient.db,
      f.releaseId,
      "assets/app.js.map",
    );
    expect(row?.contentHash).toBe(sha256Hex(bytes));
    const stored = await readStorageBytes(storage, row?.storageKey ?? "");
    expect(stored.equals(bytes)).toBe(true);
  });

  it("maps known bytes to their known SHA-256", async () => {
    const f = await fixture("known");
    const res = await upload(app, f.token, VERSION, {
      artifactPath: "assets/hello.js",
      artifactType: "minified_asset",
      bytes: bytesOf("hello"),
    });
    expect(res.statusCode).toBe(201);
    expect(
      (res.json() as { artifact: { contentHash: string } }).artifact
        .contentHash,
    ).toBe(HELLO_SHA);
  });

  it("lets the server hash win over a mismatched preflight declaration", async () => {
    const f = await fixture("mismatch");
    const bytes = bytesOf("var real = 1;");
    const realHash = sha256Hex(bytes);
    const wrongHash = "f".repeat(64);
    expect(wrongHash).not.toBe(realHash);
    const check = await preflight(app, f.token, VERSION, [
      {
        artifactPath: "assets/real.js",
        artifactType: "minified_asset",
        contentHash: wrongHash,
        sizeBytes: bytes.length,
      },
    ]);
    expect(check.statusCode).toBe(200);
    expect(
      (check.json() as { results: Array<{ verdict: string }> }).results[0]
        ?.verdict,
    ).toBe("upload");
    const up = await upload(app, f.token, VERSION, {
      artifactPath: "assets/real.js",
      artifactType: "minified_asset",
      bytes,
    });
    expect(up.statusCode).toBe(201);
    expect(
      (up.json() as { artifact: { contentHash: string } }).artifact.contentHash,
    ).toBe(realHash);
  });

  it("runs the preflight upload/exists/conflict matrix", async () => {
    const f = await fixture("matrix");
    const known = bytesOf("var known = 1;");
    const knownHash = sha256Hex(known);
    const entry = (
      artifactPath: string,
      contentHash: string,
      sizeBytes: number,
    ): unknown => ({
      artifactPath,
      artifactType: "minified_asset",
      contentHash,
      sizeBytes,
    });
    const first = await preflight(app, f.token, VERSION, [
      entry("assets/new.js", knownHash, known.length),
    ]);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      release: { id: string; version: string };
      results: Array<{ artifactPath: string; verdict: string }>;
    };
    expect(firstBody.release).toEqual({ id: f.releaseId, version: VERSION });
    expect(firstBody.results[0]).toMatchObject({
      artifactPath: "assets/new.js",
      verdict: "upload",
    });

    const up = await upload(app, f.token, VERSION, {
      artifactPath: "assets/new.js",
      artifactType: "minified_asset",
      bytes: known,
    });
    expect(up.statusCode).toBe(201);

    const second = await preflight(app, f.token, VERSION, [
      entry("assets/new.js", knownHash, known.length),
      entry("assets/new.js", "0".repeat(64), 8),
    ]);
    // Duplicate canonical paths in one manifest are rejected outright.
    expect(second.statusCode).toBe(400);

    const third = await preflight(app, f.token, VERSION, [
      entry("assets/new.js", knownHash, known.length),
    ]);
    expect(
      (third.json() as { results: Array<{ verdict: string }> }).results[0]
        ?.verdict,
    ).toBe("exists");

    const fourth = await preflight(app, f.token, VERSION, [
      entry("assets/new.js", "0".repeat(64), 8),
    ]);
    expect(
      (fourth.json() as { results: Array<{ verdict: string }> }).results[0]
        ?.verdict,
    ).toBe("conflict");
  });

  it("re-uploads identical bytes idempotently", async () => {
    const f = await fixture("idem");
    const bytes = bytesOf("var idem = 1;");
    const first = await upload(app, f.token, VERSION, {
      artifactPath: "assets/idem.js",
      artifactType: "minified_asset",
      bytes,
    });
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { artifact: { id: string } }).artifact.id;
    const second = await upload(app, f.token, VERSION, {
      artifactPath: "assets/idem.js",
      artifactType: "minified_asset",
      bytes,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as {
      artifact: { id: string };
      created: boolean;
    };
    expect(secondBody.created).toBe(false);
    expect(secondBody.artifact.id).toBe(firstId);
  });

  it("conflicts without overwriting stored bytes", async () => {
    const f = await fixture("conflict");
    const original = bytesOf("var locked = 1;");
    const first = await upload(app, f.token, VERSION, {
      artifactPath: "assets/locked.js",
      artifactType: "minified_asset",
      bytes: original,
    });
    expect(first.statusCode).toBe(201);
    const res = await upload(app, f.token, VERSION, {
      artifactPath: "assets/locked.js",
      artifactType: "minified_asset",
      bytes: bytesOf("var locked = 2;"),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "ARTIFACT_PATH_CONFLICT" });
    const row = await ReleaseRepo.findArtifactByReleaseAndPath(
      dbClient.db,
      f.releaseId,
      "assets/locked.js",
    );
    expect(row?.contentHash).toBe(sha256Hex(original));
    const stored = await readStorageBytes(storage, row?.storageKey ?? "");
    expect(stored.equals(original)).toBe(true);
    expect((await readdir(stagingDir)).length).toBe(0);
  });

  it("rejects the full traversal matrix with nothing outside the root", async () => {
    const f = await fixture("traversal");
    const filesBefore = await listFilesRecursive(storageRoot);
    // One legitimate upload: the root must gain exactly its blob.
    const legit = bytesOf("var legit = 1;");
    const legitRes = await upload(app, f.token, VERSION, {
      artifactPath: "assets/legit.js",
      artifactType: "minified_asset",
      bytes: legit,
    });
    expect(legitRes.statusCode).toBe(201);

    const hostile: UploadOptions[] = [
      { artifactPath: "../escape.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "foo/../../escape.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "/escape.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "C:\\escape.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "C:/escape.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "\\\\server\\share.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "assets/nul.map", bytes: bytesOf(VALID_MAP) },
      { artifactPath: "%2e%2e/escape.map", bytes: bytesOf(VALID_MAP) },
      {
        artifactPath: "assets/app.js.map",
        artifactType: "source_map",
        bytes: bytesOf("not json"),
      },
      {
        artifactPath: "payload.exe",
        artifactType: "minified_asset",
        bytes: bytesOf("var a = 1;"),
      },
    ];
    for (const attempt of hostile) {
      const res = await upload(app, f.token, VERSION, {
        artifactType: "source_map",
        ...attempt,
      });
      expect(res.statusCode).toBe(400);
      expect([
        "ARTIFACT_PATH_INVALID",
        "INVALID_ARTIFACT_TYPE",
        "INVALID_SOURCE_MAP",
      ]).toContain((res.json() as { code: string }).code);
    }
    // Nothing escaped: every file on disk lives under the root with no
    // temp residue, and the hostile batch added no blob — only the
    // legitimate upload's content-addressed file is new. (The root is
    // shared across this suite's tests, so the assertion is
    // before/after, not absolute.)
    const files = await listFilesRecursive(storageRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith(storageRoot)).toBe(true);
      expect(file).not.toMatch(/\.part$/);
    }
    const rows = await ReleaseRepo.listArtifactsByRelease(
      dbClient.db,
      f.releaseId,
    );
    expect(rows.map((r) => r.artifactPath)).toEqual(["assets/legit.js"]);
    expect(files).toHaveLength(filesBefore.length + 1);
    expect((await readdir(stagingDir)).length).toBe(0);
  });

  it("accepts exactly-at-limit bytes and rejects over-limit with 413", async () => {
    const f = await fixture("limits");
    const edge = Buffer.alloc(MAX_FILE_BYTES, "a");
    const ok = await upload(app, f.token, VERSION, {
      artifactPath: "assets/edge.js",
      artifactType: "minified_asset",
      bytes: edge,
    });
    expect(ok.statusCode).toBe(201);
    expect(
      (ok.json() as { artifact: { sizeBytes: number } }).artifact.sizeBytes,
    ).toBe(MAX_FILE_BYTES);

    const over = Buffer.alloc(MAX_FILE_BYTES + 1, "a");
    const denied = await upload(app, f.token, VERSION, {
      artifactPath: "assets/over.js",
      artifactType: "minified_asset",
      bytes: over,
    });
    expect(denied.statusCode).toBe(413);
    expect(denied.json()).toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    const missing = await ReleaseRepo.findArtifactByReleaseAndPath(
      dbClient.db,
      f.releaseId,
      "assets/over.js",
    );
    expect(missing).toBeUndefined();
    expect((await readdir(stagingDir)).length).toBe(0);
  });

  it("streams uploads larger than the default JSON body limit", async () => {
    const f = await fixture("large");
    // 1.5 MiB > Fastify's 1 MiB default bodyLimit: proves the
    // multipart/fileSize limits (not the JSON limit) govern uploads.
    const big = Buffer.alloc(Math.floor(1.5 * MiB), "b");
    const res = await upload(app, f.token, VERSION, {
      artifactPath: "assets/big.js",
      artifactType: "minified_asset",
      bytes: big,
    });
    expect(res.statusCode).toBe(201);
    expect(
      (res.json() as { artifact: { sizeBytes: number } }).artifact.sizeBytes,
    ).toBe(big.length);
  });

  it("tolerates realistic MIME types and rejects dangerous ones", async () => {
    const f = await fixture("mime");
    const bytes = bytesOf("var mime = 1;");
    for (const [index, contentType] of [
      "application/octet-stream",
      "application/json",
      "text/javascript",
      "application/javascript",
      "text/plain",
    ].entries()) {
      const res = await upload(app, f.token, VERSION, {
        artifactPath: `assets/mime-${index}.js`,
        artifactType: "minified_asset",
        bytes,
        contentType,
      });
      expect(res.statusCode).toBe(201);
    }
    const empty = await upload(app, f.token, VERSION, {
      artifactPath: "assets/mime-empty.js",
      artifactType: "minified_asset",
      bytes,
      contentType: null,
    });
    expect(empty.statusCode).toBe(201);
    const denied = await upload(app, f.token, VERSION, {
      artifactPath: "assets/mime-evil.js",
      artifactType: "minified_asset",
      bytes,
      contentType: "text/html",
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
  });

  it("rejects malformed maps, renamed binaries and non-JS extensions", async () => {
    const f = await fixture("content");
    const badMap = await upload(app, f.token, VERSION, {
      artifactPath: "assets/broken.js.map",
      artifactType: "source_map",
      bytes: bytesOf("not json"),
    });
    expect(badMap.statusCode).toBe(400);
    expect(badMap.json()).toMatchObject({ code: "INVALID_SOURCE_MAP" });

    const binary = await upload(app, f.token, VERSION, {
      artifactPath: "assets/evil.js",
      artifactType: "minified_asset",
      bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    });
    expect(binary.statusCode).toBe(400);
    expect(binary.json()).toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });

    const markup = await upload(app, f.token, VERSION, {
      artifactPath: "assets/page.js",
      artifactType: "minified_asset",
      bytes: bytesOf("<svg width='1'></svg>"),
    });
    expect(markup.statusCode).toBe(400);

    for (const artifactPath of ["styles.css", "page.html", "image.svg"]) {
      const res = await upload(app, f.token, VERSION, {
        artifactPath,
        artifactType: "minified_asset",
        bytes: bytesOf("var a = 1;"),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_ARTIFACT_TYPE" });
    }
    const rows = await ReleaseRepo.listArtifactsByRelease(
      dbClient.db,
      f.releaseId,
    );
    expect(rows).toEqual([]);
    expect((await readdir(stagingDir)).length).toBe(0);
  });

  it("accepts fields after the file part (wire-order independent)", async () => {
    const f = await fixture("order");
    const bytes = bytesOf("var order = 1;");
    const res = await upload(app, f.token, VERSION, {
      artifactPath: "assets/order.js",
      artifactType: "minified_asset",
      bytes,
      fileFirst: true,
    });
    expect(res.statusCode).toBe(201);
    expect(
      (res.json() as { artifact: { contentHash: string } }).artifact
        .contentHash,
    ).toBe(sha256Hex(bytes));
  });

  it("rejects uploads without a file or without metadata", async () => {
    const f = await fixture("shape");
    const noFile = await upload(app, f.token, VERSION, {
      artifactPath: "assets/none.js",
      artifactType: "minified_asset",
      bytes: undefined,
    });
    expect(noFile.statusCode).toBe(400);
    const noMeta = await upload(app, f.token, VERSION, {
      bytes: bytesOf("var a = 1;"),
      omitFields: true,
    });
    expect(noMeta.statusCode).toBe(400);
  });

  it("returns 404 for unknown releases", async () => {
    const f = await fixture("missing");
    const check = await preflight(app, f.token, "nope@0.0.0", [
      {
        artifactPath: "assets/a.js",
        artifactType: "minified_asset",
        contentHash: "a".repeat(64),
        sizeBytes: 8,
      },
    ]);
    expect(check.statusCode).toBe(404);
    expect(check.json()).toMatchObject({ code: "NOT_FOUND" });
    const up = await upload(app, f.token, "nope@0.0.0", {
      artifactPath: "assets/a.js",
      artifactType: "minified_asset",
      bytes: bytesOf("var a = 1;"),
    });
    expect(up.statusCode).toBe(404);
  });

  it("denies public keys, missing auth, revoked tokens and cross-project access", async () => {
    const f = await fixture("denied");
    const otherStamp = `${Date.now()}-other`;
    const otherCookie = await signup(
      app,
      `art-other-${otherStamp}@example.com`,
    );
    const other = await createWorkspaceAndProject(
      app,
      otherCookie,
      `other ${otherStamp}`,
    );
    const otherSecret = await createSecretToken(
      app,
      otherCookie,
      other.projectId,
    );
    await createRelease(app, otherSecret.token, VERSION);

    const entry = {
      artifactPath: "assets/a.js",
      artifactType: "minified_asset",
      contentHash: "a".repeat(64),
      sizeBytes: 8,
    };
    // Public ingest key on both endpoints.
    expect(
      (await preflight(app, f.bootstrapKey, VERSION, [entry])).statusCode,
    ).toBe(401);
    expect(
      (
        await upload(app, f.bootstrapKey, VERSION, {
          artifactPath: "assets/a.js",
          artifactType: "minified_asset",
          bytes: bytesOf("var a = 1;"),
        })
      ).statusCode,
    ).toBe(401);
    // Missing auth.
    expect((await preflight(app, null, VERSION, [entry])).statusCode).toBe(401);
    expect(
      (
        await upload(app, null, VERSION, {
          artifactPath: "assets/a.js",
          artifactType: "minified_asset",
          bytes: bytesOf("var a = 1;"),
        })
      ).statusCode,
    ).toBe(401);
    // Cross-project: token B cannot see project A's release (404, not 403,
    // to avoid existence oracle across tenants).
    expect(
      (await preflight(app, otherSecret.token, "only-in-a@1.0.0", [entry]))
        .statusCode,
    ).toBe(404);
    await createRelease(app, f.token, "only-in-a@1.0.0");
    expect(
      (await preflight(app, otherSecret.token, "only-in-a@1.0.0", [entry]))
        .statusCode,
    ).toBe(404);
    const crossUpload = await upload(
      app,
      otherSecret.token,
      "only-in-a@1.0.0",
      {
        artifactPath: "assets/a.js",
        artifactType: "minified_asset",
        bytes: bytesOf("var a = 1;"),
      },
    );
    expect(crossUpload.statusCode).toBe(404);
    // Revoked token denied on both endpoints.
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${f.projectId}/secret-tokens/${f.tokenId}/revoke`,
      headers: { cookie: f.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect((await preflight(app, f.token, VERSION, [entry])).statusCode).toBe(
      401,
    );
    expect(
      (
        await upload(app, f.token, VERSION, {
          artifactPath: "assets/a.js",
          artifactType: "minified_asset",
          bytes: bytesOf("var a = 1;"),
        })
      ).statusCode,
    ).toBe(401);
  });

  it("rejects bounded-manifest violations on preflight", async () => {
    const f = await fixture("preflight-caps");
    const entry = (index: number): unknown => ({
      artifactPath: `assets/p${index}.js`,
      artifactType: "minified_asset",
      contentHash: "a".repeat(64),
      sizeBytes: 8,
    });
    const tooMany = await preflight(
      app,
      f.token,
      VERSION,
      Array.from({ length: 501 }, (_, i) => entry(i)),
    );
    expect(tooMany.statusCode).toBe(400);
    const empty = await preflight(app, f.token, VERSION, []);
    expect(empty.statusCode).toBe(400);
    // Aggregate over ~250 MiB with every entry individually under the
    // per-file cap: 130 × 2 MiB = 260 MiB of declarations.
    const aggregate = await preflight(
      app,
      f.token,
      VERSION,
      Array.from({ length: 130 }, (_, i) => ({
        artifactPath: `assets/agg-${i}.js`,
        artifactType: "minified_asset",
        contentHash: "a".repeat(64),
        sizeBytes: MAX_FILE_BYTES,
      })),
    );
    expect(aggregate.statusCode).toBe(413);
    expect(aggregate.json()).toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });
});

describe("RS-06 storage outage (real PG, failing storage)", () => {
  let outageApp: AppInstance;
  let outageDb: DbClient;

  beforeAll(async () => {
    outageDb = createTestDbClient();
    const failing: ArtifactStorage = {
      root: "outage-root",
      put: async () => {
        throw new ArtifactStorageError("disk gone");
      },
      get: async () => {
        throw new ArtifactStorageError("disk gone");
      },
      exists: async () => false,
      delete: async () => false,
    };
    outageApp = await buildApp({
      config: testApiConfig(),
      dbClient: outageDb,
      artifactStorage: failing,
    });
  });

  beforeEach(async () => {
    await resetTestDatabase(outageDb);
  });

  afterAll(async () => {
    await outageApp.close();
    await outageDb.close();
  });

  it("returns 503 with requestId and stores no row", async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cookie = await signup(outageApp, `out-${stamp}@example.com`);
    const { projectId } = await createWorkspaceAndProject(
      outageApp,
      cookie,
      `out ${stamp}`,
    );
    const secret = await createSecretToken(outageApp, cookie, projectId);
    await createRelease(outageApp, secret.token, VERSION);
    const res = await upload(outageApp, secret.token, VERSION, {
      artifactPath: "assets/doomed.js",
      artifactType: "minified_asset",
      bytes: bytesOf("var doomed = 1;"),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { code: string; requestId: string };
    expect(body.code).toBe("ARTIFACT_STORAGE_UNAVAILABLE");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    const rows = await outageDb.pool.query(
      "SELECT COUNT(*)::int AS count FROM release_artifacts",
    );
    expect((rows.rows[0] as { count: number }).count).toBe(0);
  });
});
