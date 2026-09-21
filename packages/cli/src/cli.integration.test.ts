import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Cross-package test wiring follows the api-client precedent
// (packages/api-client/scripts/generate-openapi.ts imports apps/api
// source directly); the @replaybug/api devDependency is the honest
// Turbo edge that orders the api build before these tests.
import { buildApp } from "../../../apps/api/src/app.js";
import type { AppInstance } from "../../../apps/api/src/instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../../../apps/api/src/test-helpers.js";
import type { DbClient } from "@replaybug/db";

/**
 * RS-07 CLI integration: the BUILT binary (`bin/replaybug.js` over
 * `dist/`) as a child process against a REAL API (ephemeral port, real
 * PostgreSQL, real temp filesystem). Proves projects info, release
 * create idempotency + metadata conflicts, deterministic credential-free
 * listing, upload skip-existing with ~0 re-uploaded bytes, conflict
 * no-overwrite, invalid-map/too-large/unreachable failures — and that
 * the token never appears in any captured output.
 */

const PASSWORD = "TestPass123!";
const MiB = 1024 * 1024;
const MAX_FILE_BYTES = 2 * MiB;
const VERSION = "web@9.9.9";
const VALID_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: [],
  mappings: "AAAA",
});

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "replaybug.js");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  cookie: string;
  projectId: string;
  bootstrapKey: string;
  token: string;
  tokenId: string;
}

/** Every secret minted during the run: outputs must never contain them. */
const knownSecrets: string[] = [];

function trackSecret(secret: string): string {
  knownSecrets.push(secret);
  return secret;
}

function assertNoSecrets(stdout: string, stderr: string): void {
  for (const secret of knownSecrets) {
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  }
}

function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

async function signup(app: AppInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "CLI Tester" },
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

async function fixture(tag: string, app: AppInstance): Promise<Fixture> {
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const cookie = await signup(app, `cli-${tag}-${stamp}@example.com`);
  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: `CLI WS ${tag} ${stamp}` },
  });
  expect(wsRes.statusCode).toBe(201);
  const ws = wsRes.json() as { id: string };
  const projRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws.id}/projects`,
    headers: { cookie },
    payload: { name: `CLI Proj ${tag} ${stamp}` },
  });
  expect(projRes.statusCode).toBe(201);
  const created = projRes.json() as {
    project: { id: string };
    bootstrap: { key: string };
  };
  const tokenRes = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${created.project.id}/secret-tokens`,
    headers: { cookie },
    payload: { name: "cli-token" },
  });
  expect(tokenRes.statusCode).toBe(201);
  const secret = tokenRes.json() as { id: string; token: string };
  return {
    cookie,
    projectId: created.project.id,
    bootstrapKey: trackSecret(created.bootstrap.key),
    token: trackSecret(secret.token),
    tokenId: secret.id,
  };
}

async function revokeToken(app: AppInstance, f: Fixture): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${f.projectId}/secret-tokens/${f.tokenId}/revoke`,
    headers: { cookie: f.cookie },
  });
  expect(res.statusCode).toBe(200);
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

describe("RS-07 CLI against a real API (built binary)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let apiUrl = "";
  let storageRoot = "";
  let stagingDir = "";
  const tempDirs: string[] = [];

  async function runCli(
    args: string[],
    options: {
      token?: string | undefined;
      apiUrlOverride?: string | undefined;
    } = {},
  ): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPLAYBUG_API_URL: options.apiUrlOverride ?? apiUrl,
      REPLAYBUG_DEBUG: "",
    };
    delete env["REPLAYBUG_AUTH_TOKEN"];
    if (options.token !== undefined) {
      env["REPLAYBUG_AUTH_TOKEN"] = options.token;
    }
    let code = 0;
    let stdout: string;
    let stderr: string;
    try {
      const result = await execFileAsync(process.execPath, [binPath, ...args], {
        env,
        timeout: 60_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const exec = error as {
        stdout?: unknown;
        stderr?: unknown;
        code?: unknown;
      };
      code = typeof exec.code === "number" ? exec.code : 1;
      stdout = typeof exec.stdout === "string" ? exec.stdout : "";
      stderr = typeof exec.stderr === "string" ? exec.stderr : "";
    }
    assertNoSecrets(stdout, stderr);
    return { code, stdout, stderr };
  }

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    dbClient = createTestDbClient();
    storageRoot = await mkdtemp(join(tmpdir(), "rs07-cli-storage-"));
    stagingDir = await mkdtemp(join(tmpdir(), "rs07-cli-staging-"));
    app = await buildApp({
      config: testApiConfig({
        artifactDir: storageRoot,
        artifactMaxFileBytes: MAX_FILE_BYTES,
        artifactStagingDir: stagingDir,
      }),
      dbClient,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("API did not bind to a TCP port");
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    await rm(storageRoot, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("projects info succeeds with a token and fails without one", async () => {
    const f = await fixture("info", app);
    const ok = await runCli(["projects", "info"], { token: f.token });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(f.projectId);

    const missing = await runCli(["projects", "info"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("REPLAYBUG_AUTH_TOKEN");
  }, 60_000);

  it("rejects unknown, revoked, and public-key credentials as non-zero", async () => {
    const f = await fixture("auth", app);
    const unknownToken = `rb_sk_deadbeef_${"A".repeat(43)}`;
    trackSecret(unknownToken);

    const wrong = await runCli(["projects", "info"], {
      token: unknownToken,
    });
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("REPLAYBUG_AUTH_TOKEN");

    const publicKey = await runCli(["projects", "info"], {
      token: f.bootstrapKey,
    });
    expect(publicKey.code).not.toBe(0);

    await revokeToken(app, f);
    const revoked = await runCli(["projects", "info"], { token: f.token });
    expect(revoked.code).not.toBe(0);
    expect(revoked.stderr).toContain("REPLAYBUG_AUTH_TOKEN");
  }, 60_000);

  it("creates releases idempotently and rejects conflicting metadata", async () => {
    const f = await fixture("releases", app);
    const first = await runCli(
      [
        "releases",
        "create",
        VERSION,
        "--commit-sha",
        "abc123def456abc123def456abc123def456abcd",
        "--repository-url",
        "https://example.com/repo",
      ],
      { token: f.token },
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("created");

    const second = await runCli(["releases", "create", VERSION], {
      token: f.token,
    });
    // Bare re-create disagrees with the stored metadata: a clear
    // non-zero conflict (the stored row is untouched).
    expect(second.code).not.toBe(0);
    expect(second.stderr).toMatch(/already exists with different metadata/i);
    expect(second.stderr).toContain("Hint:");

    const identical = await runCli(
      [
        "releases",
        "create",
        VERSION,
        "--commit-sha",
        "abc123def456abc123def456abc123def456abcd",
        "--repository-url",
        "https://example.com/repo",
        "--json",
      ],
      { token: f.token },
    );
    expect(identical.code).toBe(0);
    const parsed = JSON.parse(identical.stdout) as { created: boolean };
    expect(parsed.created).toBe(false);
  }, 60_000);

  it("lists releases deterministically with no credentials", async () => {
    const f = await fixture("list", app);
    await runCli(["releases", "create", "web@1.0.0"], { token: f.token });
    await runCli(["releases", "create", "web@2.0.0"], { token: f.token });

    const listed = await runCli(["releases", "list", "--json"], {
      token: f.token,
    });
    expect(listed.code).toBe(0);
    const parsed = JSON.parse(listed.stdout) as {
      releases: Array<{ version: string }>;
    };
    expect(parsed.releases.map((r) => r.version)).toEqual([
      "web@1.0.0",
      "web@2.0.0",
    ]);
    expect(listed.stdout.toLowerCase()).not.toContain("token");
    expect(listed.stdout.toLowerCase()).not.toContain("secret");

    const human = await runCli(["releases", "list"], { token: f.token });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("web@1.0.0");
    expect(human.stdout).toContain("web@2.0.0");
  }, 60_000);

  it("uploads source maps, then skips existing bytes on the second run", async () => {
    const f = await fixture("upload", app);
    const dir = await makeTempDir("rs07-upload-");
    await mkdir(join(dir, "assets"), { recursive: true });
    const js = "console.log(1);\n//# sourceMappingURL=app-HASH.js.map\n";
    await writeFile(join(dir, "assets", "app-HASH.js"), js);
    await writeFile(join(dir, "assets", "app-HASH.js.map"), VALID_MAP);
    await writeFile(join(dir, "index.html"), "<html></html>");

    const first = await runCli(
      ["sourcemaps", "upload", dir, "--release", VERSION],
      { token: f.token },
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Found: 1 source map / 1 minified asset");
    expect(first.stdout).toContain("Uploaded: 2");
    expect(first.stdout).toContain("Already present: 0");
    const storedAfterFirst = await listFilesRecursive(storageRoot);

    const second = await runCli(
      ["sourcemaps", "upload", dir, "--release", VERSION, "--json"],
      { token: f.token },
    );
    expect(second.code).toBe(0);
    const summary = JSON.parse(second.stdout) as {
      uploaded: number;
      alreadyPresent: number;
    };
    expect(summary.uploaded).toBe(0);
    expect(summary.alreadyPresent).toBe(2);
    const storedAfterSecond = await listFilesRecursive(storageRoot);
    expect(storedAfterSecond.sort()).toEqual(storedAfterFirst.sort());
  }, 120_000);

  it("fails on conflicting bytes without overwriting stored content", async () => {
    const f = await fixture("conflict", app);
    const dir = await makeTempDir("rs07-conflict-");
    const jsV1 = "console.log(1);\n//# sourceMappingURL=app.js.map\n";
    await writeFile(join(dir, "app.js"), jsV1);
    await writeFile(join(dir, "app.js.map"), VALID_MAP);

    const first = await runCli(
      ["sourcemaps", "upload", dir, "--release", VERSION],
      { token: f.token },
    );
    expect(first.code).toBe(0);
    const hashV1 = sha256Hex(jsV1);
    const hashMap = sha256Hex(VALID_MAP);

    const jsV2 = "console.log(2);\n//# sourceMappingURL=app.js.map\n";
    const hashV2 = sha256Hex(jsV2);
    await writeFile(join(dir, "app.js"), jsV2);

    const conflict = await runCli(
      ["sourcemaps", "upload", dir, "--release", VERSION],
      { token: f.token },
    );
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toMatch(/conflict/i);
    expect(conflict.stderr).toContain("app.js");

    const storedHashes = new Set<string>();
    for (const file of await listFilesRecursive(storageRoot)) {
      storedHashes.add(sha256Hex(await readFile(file)));
    }
    expect(storedHashes.has(hashV1)).toBe(true);
    expect(storedHashes.has(hashMap)).toBe(true);
    expect(storedHashes.has(hashV2)).toBe(false);
  }, 120_000);

  it("reports invalid maps, oversized files, and unreachable APIs clearly", async () => {
    const f = await fixture("failures", app);

    const badDir = await makeTempDir("rs07-badmap-");
    await writeFile(join(badDir, "bad.js"), "var x = 1;\n");
    await writeFile(join(badDir, "bad.js.map"), "this is not json{{{");
    const badMap = await runCli(
      ["sourcemaps", "upload", badDir, "--release", VERSION],
      { token: f.token },
    );
    expect(badMap.code).not.toBe(0);
    expect(badMap.stderr).toMatch(/source map/i);
    expect(badMap.stderr).toContain("bad.js.map");
    expect(badMap.stderr).toContain("Request ID:");

    const bigDir = await makeTempDir("rs07-big-");
    const bigJs = `var padding = "${"x".repeat(3 * MiB)}";\n//# sourceMappingURL=big.js.map\n`;
    await writeFile(join(bigDir, "big.js"), bigJs);
    await writeFile(join(bigDir, "big.js.map"), VALID_MAP);
    const tooLarge = await runCli(
      ["sourcemaps", "upload", bigDir, "--release", VERSION],
      { token: f.token },
    );
    expect(tooLarge.code).not.toBe(0);
    expect(tooLarge.stderr).toMatch(/cap|too large|exceed/i);

    const unreachable = await runCli(["projects", "info"], {
      token: f.token,
      apiUrlOverride: "http://127.0.0.1:1",
    });
    expect(unreachable.code).not.toBe(0);
    expect(unreachable.stderr).toContain("Cannot reach the API");
    expect(unreachable.stderr).not.toMatch(/\n\s+at [^(]*\(/);
  }, 180_000);

  it("skips symlink escapes with a warning and uploads the rest", async () => {
    const f = await fixture("symlink", app);
    const dir = await makeTempDir("rs07-link-");
    const outside = await makeTempDir("rs07-outside-");
    await writeFile(join(outside, "secret.js.map"), VALID_MAP);
    await writeFile(join(dir, "ok.js"), "var ok = 1;\n");
    await writeFile(join(dir, "ok.js.map"), VALID_MAP);
    try {
      await symlink(join(outside, "secret.js.map"), join(dir, "evil.js.map"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: unknown }).code === "EPERM" ||
          (error as { code?: unknown }).code === "EACCES")
      ) {
        return;
      }
      throw error;
    }

    const result = await runCli(
      ["sourcemaps", "upload", dir, "--release", VERSION],
      { token: f.token },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/symlink/i);
    expect(result.stdout).toContain("Uploaded: 2");
  }, 120_000);
});
