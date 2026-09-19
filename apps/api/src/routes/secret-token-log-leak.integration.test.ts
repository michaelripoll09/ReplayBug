import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

/**
 * RS-12 secret-token log-leak capture (real built API child process + real
 * built CLI binary + real PG + real temp FS).
 *
 * A synthetic secret token is minted through the management API and then
 * exercised across every surface that could echo it: API stdout/stderr
 * (request/error logs at debug level), CLI stdout/stderr on success AND on
 * the revoked-token failure path, the token-list response body, the
 * `project_keys` rows (hash/prefix only by design) and every `audit_logs`
 * row for the workspace.
 *
 * The synthetic secret must appear ZERO times outside the single in-memory
 * creation response that the caller already holds. All assertions are
 * boolean predicates so a failure never prints the secret itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const API_ENTRY = join(REPO_ROOT, "apps", "api", "dist", "server.js");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "bin", "replaybug.js");
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

const PASSWORD = "TestPass123!";

function isSecretTokenShape(value: string): boolean {
  return /^rb_sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(value);
}

function lacksSecret(haystack: string, secret: string): boolean {
  return secret.length > 0 && !haystack.includes(secret);
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  apiUrl: string,
  args: string[],
  token: string | null,
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPLAYBUG_API_URL: apiUrl,
    };
    delete env["REPLAYBUG_AUTH_TOKEN"];
    if (token !== null) {
      env["REPLAYBUG_AUTH_TOKEN"] = token;
    }
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("RS-12 secret-token log-leak capture", () => {
  let api: ChildProcess | null = null;
  let apiOutput = "";
  let apiUrl = "";
  let artifactDir = "";

  beforeAll(async () => {
    if (!existsSync(API_ENTRY)) {
      throw new Error(
        `API build missing at ${API_ENTRY}. Run "pnpm build" before this suite.`,
      );
    }
    if (!existsSync(CLI_BIN)) {
      throw new Error(
        `CLI build missing at ${CLI_BIN}. Run "pnpm build" before this suite.`,
      );
    }
    artifactDir = await mkdtemp(join(tmpdir(), "rs12-leak-artifacts-"));

    let lastError: unknown = null;
    for (const port of [4021, 4022, 4023]) {
      apiOutput = "";
      const child = spawn(process.execPath, [API_ENTRY], {
        cwd: join(REPO_ROOT, "apps", "api"),
        env: {
          ...process.env,
          NODE_ENV: "test",
          LOG_LEVEL: "debug",
          REPLAYBUG_DATABASE_URL: DB_URL,
          REPLAYBUG_API_PORT: String(port),
          REPLAYBUG_API_HOST: "127.0.0.1",
          REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
          REPLAYBUG_USER_HMAC_SECRET:
            "test-hmac-secret-0123456789abcdef0123456789",
          REPLAYBUG_WEB_URL: "http://localhost:3000",
          REPLAYBUG_API_URL: `http://127.0.0.1:${port}`,
          REPLAYBUG_TRUSTED_ORIGINS: "http://localhost:3000",
          REPLAYBUG_ARTIFACT_DIR: artifactDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      api = child;
      child.stdout?.on("data", (chunk: Buffer) => {
        apiOutput += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        apiOutput += chunk.toString("utf8");
      });
      const candidate = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 30_000;
      let ready = false;
      let busy = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          busy = /EADDRINUSE/.test(apiOutput);
          break;
        }
        try {
          const res = await fetch(`${candidate}/health/ready`);
          if (res.status === 200) {
            await res.body?.cancel().catch(() => undefined);
            ready = true;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (ready) {
        apiUrl = candidate;
        lastError = null;
        break;
      }
      child.kill();
      api = null;
      lastError = busy
        ? new Error(`port ${port} busy, trying next`)
        : new Error(
            `API child failed to become ready on ${port}: ${apiOutput.slice(-2000)}`,
          );
      if (!busy) {
        break;
      }
    }
    if (api === null || apiUrl === "") {
      throw lastError ?? new Error("API child failed to start");
    }
  }, 120_000);

  afterAll(async () => {
    const child = api;
    api = null;
    if (child !== null && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    await rm(artifactDir, { recursive: true, force: true });
  });

  it("never echoes the synthetic secret outside the one-time creation response", async () => {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let jar = "";
    async function apiFetch(
      path: string,
      init: { method?: string; body?: unknown } = {},
    ): Promise<{ status: number; json: unknown; text: string }> {
      const headers: Record<string, string> = {};
      if (init.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (jar !== "") {
        headers["cookie"] = jar;
      }
      const res = await fetch(`${apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const setCookies = res.headers.getSetCookie();
      if (setCookies.length > 0) {
        jar = setCookies.map((c) => c.split(";")[0] ?? "").join("; ");
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text === "" ? null : (JSON.parse(text) as unknown);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    }
    function record(value: unknown): value is Record<string, unknown> {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    }
    function field(owner: Record<string, unknown>, key: string): string {
      const value = owner[key];
      if (typeof value !== "string") {
        throw new Error(`expected string field "${key}"`);
      }
      return value;
    }

    // User + workspace + project + origin through the real HTTP stack.
    const signup = await apiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: {
        email: `leak-${stamp}@example.com`,
        password: PASSWORD,
        name: "Leak",
      },
    });
    expect([200, 201]).toContain(signup.status);
    const ws = await apiFetch("/api/v1/workspaces", {
      method: "POST",
      body: { name: `Leak WS ${stamp}` },
    });
    expect(ws.status).toBe(201);
    if (!record(ws.json)) {
      throw new Error("workspace create returned a non-object");
    }
    const workspaceId = field(ws.json, "id");
    const proj = await apiFetch(`/api/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      body: { name: `Leak Proj ${stamp}` },
    });
    expect(proj.status).toBe(201);
    if (!record(proj.json)) {
      throw new Error("project create returned a non-object");
    }
    const project = proj.json["project"];
    if (!record(project)) {
      throw new Error("project create has no project object");
    }
    const projectId = field(project, "id");
    const originRes = await apiFetch(`/api/v1/projects/${projectId}/origins`, {
      method: "POST",
      body: { origin: "https://leak.example.com" },
    });
    expect(originRes.status).toBe(201);

    // THE one-time creation response: the only place the secret may appear.
    const createdRes = await apiFetch(
      `/api/v1/projects/${projectId}/secret-tokens`,
      { method: "POST", body: { name: "leak-ci" } },
    );
    expect(createdRes.status).toBe(201);
    if (!record(createdRes.json)) {
      throw new Error("secret-token create returned a non-object");
    }
    const token = field(createdRes.json, "token");
    const tokenId = field(createdRes.json, "id");
    expect(isSecretTokenShape(token)).toBe(true);

    // Every other read surface must be secret-free.
    const listed = await apiFetch(
      `/api/v1/projects/${projectId}/secret-tokens`,
    );
    expect(listed.status).toBe(200);
    expect(lacksSecret(JSON.stringify(listed.json), token)).toBe(true);

    // Bearer-authenticated CLI routes (success path) via the built binary.
    const version = `leak@${stamp}`;
    const info = await runCli(apiUrl, ["projects", "info", "--json"], token);
    expect(info.code).toBe(0);
    const mk = await runCli(
      apiUrl,
      ["releases", "create", version, "--json"],
      token,
    );
    expect(mk.code).toBe(0);
    const fixtureDir = await mkdtemp(join(tmpdir(), "rs12-leak-fixture-"));
    let uploaded: ProcResult;
    try {
      await mkdir(join(fixtureDir, "assets"), { recursive: true });
      await writeFile(
        join(fixtureDir, "assets", "app.js"),
        "var a=1;\n//# sourceMappingURL=app.js.map\n",
        "utf8",
      );
      await writeFile(
        join(fixtureDir, "assets", "app.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["../src/app.ts"],
          names: [],
          mappings: "AAAA",
        }),
        "utf8",
      );
      uploaded = await runCli(
        apiUrl,
        ["sourcemaps", "upload", fixtureDir, "--release", version, "--json"],
        token,
      );
      expect(uploaded.code).toBe(0);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }

    // Failure path: revoke, then the CLI must 401 without echoing the token.
    const revoke = await apiFetch(
      `/api/v1/projects/${projectId}/secret-tokens/${tokenId}/revoke`,
      { method: "POST", body: {} },
    );
    expect(revoke.status).toBe(200);
    const denied = await runCli(apiUrl, ["projects", "info", "--json"], token);
    expect(denied.code).not.toBe(0);

    // Give the debug log pipeline a beat to flush, then capture everything.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cliOutputs = [
      info.stdout,
      info.stderr,
      mk.stdout,
      mk.stderr,
      uploaded.stdout,
      uploaded.stderr,
      denied.stdout,
      denied.stderr,
    ];
    for (const output of cliOutputs) {
      expect(lacksSecret(output, token)).toBe(true);
    }
    expect(lacksSecret(apiOutput, token)).toBe(true);

    // Persisted rows: hashes/prefixes/metadata only, never the secret.
    const pool = new Pool({ connectionString: DB_URL });
    try {
      const keys = await pool.query(
        `SELECT row_to_json(t) AS row FROM project_keys t WHERE project_id = $1`,
        [projectId],
      );
      expect(lacksSecret(JSON.stringify(keys.rows), token)).toBe(true);
      const audit = await pool.query(
        `SELECT row_to_json(t) AS row FROM audit_logs t WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(lacksSecret(JSON.stringify(audit.rows), token)).toBe(true);
    } finally {
      await pool.end();
    }
  }, 180_000);
});
