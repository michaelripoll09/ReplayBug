import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";
import { validateGeneratedSyntax } from "../../../packages/reproducer/src/syntax.js";
import { uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * RS-12 source-map E2E matrix (real PG + real API + real worker + real web
 * + production demo builds with source maps).
 *
 * - E2E-RS12-1 FULL: dashboard/API project setup → secret token via the API
 *   management path → real `replaybug projects info` → `releases create` →
 *   `sourcemaps upload` of a freshly built MINIFIED production demo →
 *   Chromium triggers the minified release error → real worker symbolicates
 *   → DB/API/UI assertions (genuine mapping only; mapped frames are never
 *   injected, they are computed by the worker from uploaded maps).
 * - E2E-RS12-2 CROSS: two production releases (different hashed assets,
 *   same original source) group into ONE issue with occurrence_count 2.
 * - E2E-RS12-3 MISSING: release without an uploaded map degrades to raw
 *   with `map_not_found`, no worker poison, honest dashboard state.
 * - E2E-RS12-4 REVOKED: token works → revoke via the management API → CLI
 *   401/non-zero; uploaded artifacts stay worker-readable and intact.
 * - E2E-RS12-5 TOKEN-UI gaps: copy works, reload/redaction hygiene, viewer
 *   restrictions, release readability.
 *
 * Secret hygiene: tokens live in locals only. Outputs are asserted with
 * boolean predicates (`lacksSecret`) so a failure never prints a secret.
 * API/CLI logs are covered by the vitest log-leak suite; here every CLI
 * stdout/stderr capture is additionally asserted secret-free.
 */

const API = "http://localhost:4001";
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
// Must match apps/web/playwright.config.ts (API webServer env) so the
// spawned worker shares the API's artifact root.
const ARTIFACT_DIR =
  process.env["REPLAYBUG_ARTIFACT_DIR"] ??
  join(tmpdir(), "replaybug-web-e2e-artifacts");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "bin", "replaybug.js");
const DEMO_DIR = join(REPO_ROOT, "apps", "demo");
const VITE_BIN = join(DEMO_DIR, "node_modules", "vite", "bin", "vite.js");
const WORKER_DIR = join(REPO_ROOT, "apps", "worker");
const WORKER_ENTRY = join(WORKER_DIR, "dist", "index.js");

const DEMO_PORT = 5176;
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`;
const SCENARIO_SOURCE_SUFFIX = "src/scenarios/minified-release-error.ts";
const SCENARIO_TEST_ID = "scenario-minified-release-error";
const EVIDENCE_FILE = join(tmpdir(), "rs12-evidence.jsonl");

// ---------------------------------------------------------------------------
// tiny typed helpers (strict TS, no `any`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected an array value");
  }
  return value;
}

function strField(owner: Record<string, unknown>, key: string): string {
  const value = owner[key];
  if (typeof value !== "string") {
    throw new Error(`expected string field "${key}"`);
  }
  return value;
}

function numField(owner: Record<string, unknown>, key: string): number {
  const value = owner[key];
  if (typeof value !== "number") {
    throw new Error(`expected number field "${key}"`);
  }
  return value;
}

function isSecretTokenShape(value: string): boolean {
  return /^rb_sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(value);
}

function lacksSecret(haystack: string, secret: string): boolean {
  return secret.length > 0 && !haystack.includes(secret);
}

function uniqueVersion(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}@1.0.0`;
}

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    const res = await pool.query(sql, params as unknown[]);
    return res.rows as T[];
  } finally {
    await pool.end();
  }
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  label: string,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const value = await fn();
      if (value !== null) {
        return value;
      }
    } catch {
      // Transient DB/readiness errors: keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `pollUntil(${label}) timed out after ${timeoutMs}ms (${attempts} attempts)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Append machine-readable evidence (frames, statuses) for the final report. */
async function recordEvidence(
  name: string,
  data: Record<string, unknown>,
): Promise<void> {
  const line = `${JSON.stringify({ test: name, ...data })}\n`;
  await writeFile(EVIDENCE_FILE, line, { flag: "a" });
}

// ---------------------------------------------------------------------------
// dashboard / management-API flows (session cookies ride page.request)
// ---------------------------------------------------------------------------

async function registerViaUI(
  page: Page,
  email: string,
  name: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto("/register");
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    const navigated = await page
      .waitForURL(/\/onboarding\/workspace/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (navigated) {
      return;
    }
    const limited = await page
      .getByText("Too many requests")
      .isVisible()
      .catch(() => false);
    if (limited && attempt === 0) {
      await page.waitForTimeout(65_000);
      continue;
    }
    await expect(page).toHaveURL(/\/onboarding\/workspace/, {
      timeout: 15_000,
    });
  }
}

async function onboardProject(
  page: Page,
  workspaceName: string,
  projectName: string,
): Promise<string> {
  // Unique per run: this file never resets the shared E2E database, so
  // fixed names would collide (workspace slug 409) on repeat runs.
  const suffix = Math.random().toString(36).slice(2, 8);
  await page.getByLabel("Workspace name").fill(`${workspaceName} ${suffix}`);
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });
  await page.getByLabel("Project name").fill(`${projectName}-${suffix}`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("Copy your public ingest key")).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: "I copied the key — continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/origin/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding\/complete/, { timeout: 15_000 });
  const projectId = new URL(page.url()).searchParams.get("projectId") ?? "";
  expect(projectId).not.toBe("");
  return projectId;
}

/** API sign-up with the same 429 tolerance (viewer/second-user flows). */
async function signupViaApi(email: string): Promise<boolean> {
  const ctx = await request.newContext({ baseURL: API });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email, password: E2E_PASSWORD, name: "Viewer" },
      });
      if (res.status() !== 429) {
        return res.ok();
      }
      await new Promise((resolve) => setTimeout(resolve, 65_000));
    }
    return false;
  } finally {
    await ctx.dispose();
  }
}

/** Rotate the public ingest key (one-time plaintext) and build the SDK DSN. */
async function rotateDsn(
  req: APIRequestContext,
  projectId: string,
): Promise<{
  dsn: string;
  publicKey: string;
}> {
  const res = await req.post(
    `${API}/api/v1/projects/${projectId}/keys/public/rotate`,
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as unknown;
  if (!isRecord(body)) {
    throw new Error("key rotation returned a non-object body");
  }
  const publicKey = strField(body, "key");
  expect(publicKey.startsWith("rb_pk_")).toBe(true);
  return {
    dsn: `http://${publicKey}@localhost:4001/api/ingest/v1`,
    publicKey,
  };
}

async function addOrigin(
  req: APIRequestContext,
  projectId: string,
  origin: string,
): Promise<void> {
  const res = await req.post(`${API}/api/v1/projects/${projectId}/origins`, {
    data: { origin },
  });
  expect(res.status()).toBe(201);
}

interface EnvironmentItem {
  id: string;
  name: string;
  isDefault: boolean;
}

async function configureEnvironmentBaseUrl(
  req: APIRequestContext,
  projectId: string,
): Promise<void> {
  const listRes = await req.get(
    `${API}/api/v1/projects/${projectId}/environments`,
  );
  expect(listRes.ok()).toBe(true);
  const environments = (await listRes.json()) as EnvironmentItem[];
  const environment =
    environments.find((item) => item.isDefault) ??
    environments.find((item) => item.name === "production") ??
    environments[0];
  if (environment === undefined) {
    throw new Error("project has no environment to configure");
  }

  const patchRes = await req.patch(
    `${API}/api/v1/environments/${environment.id}`,
    { data: { baseUrl: DEMO_ORIGIN } },
  );
  expect(patchRes.ok()).toBe(true);
}

async function createSecretToken(
  req: APIRequestContext,
  projectId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const res = await req.post(
    `${API}/api/v1/projects/${projectId}/secret-tokens`,
    { data: { name } },
  );
  expect(res.status()).toBe(201);
  const body = (await res.json()) as unknown;
  if (!isRecord(body)) {
    throw new Error("secret-token create returned a non-object body");
  }
  const token = strField(body, "token");
  expect(isSecretTokenShape(token)).toBe(true);
  return { id: strField(body, "id"), token };
}

async function revokeSecretToken(
  req: APIRequestContext,
  projectId: string,
  tokenId: string,
): Promise<void> {
  const res = await req.post(
    `${API}/api/v1/projects/${projectId}/secret-tokens/${tokenId}/revoke`,
  );
  expect(res.status()).toBe(200);
}

// ---------------------------------------------------------------------------
// child processes: built CLI, vite build, static preview, real worker
// ---------------------------------------------------------------------------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  envExtra: Record<string, string> = {},
): Promise<CliResult> {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `CLI build missing at ${CLI_BIN}. Run "pnpm build" before this E2E.`,
    );
  }
  return new Promise<CliResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REPLAYBUG_API_URL: API,
    };
    delete env["REPLAYBUG_AUTH_TOKEN"];
    for (const [key, value] of Object.entries(envExtra)) {
      env[key] = value;
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

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("expected a JSON object from CLI output");
  }
  return parsed;
}

async function runGeneratedTest(code: string): Promise<CliResult> {
  const dir = await mkdtemp(join(tmpdir(), "rs12-generated-test-"));
  const codeFile = join(dir, "reproduction.spec.ts");
  try {
    await writeFile(codeFile, code, "utf8");
    return await new Promise<CliResult>((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "verify:generated-test",
          "--",
          "--code-file",
          codeFile,
          "--target",
          DEMO_ORIGIN,
        ],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function buildDemoDist(dsn: string, release: string): Promise<string> {
  if (!existsSync(VITE_BIN)) {
    throw new Error(
      `Vite binary missing at ${VITE_BIN}. Run "pnpm install" before this E2E.`,
    );
  }
  const buildOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [VITE_BIN, "build"], {
      cwd: DEMO_DIR,
      env: {
        ...process.env,
        VITE_REPLAYBUG_DSN: dsn,
        VITE_REPLAYBUG_RELEASE: release,
        VITE_REPLAYBUG_ENVIRONMENT: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(
          new Error(
            `demo production build failed (exit ${code}): ${out.slice(-2000)}`,
          ),
        );
      }
    });
  });
  expect(buildOutput).toContain("built in");
  const assets = await readdir(join(DEMO_DIR, "dist", "assets"));
  const jsAssets = assets.filter(
    (name) => name.endsWith(".js") && !name.endsWith(".map"),
  );
  expect(jsAssets.length).toBeGreaterThan(0);
  for (const asset of jsAssets) {
    expect(assets).toContain(`${asset}.map`);
  }
  const target = await mkdtemp(join(tmpdir(), "rs12-demo-dist-"));
  await cp(join(DEMO_DIR, "dist"), target, { recursive: true });
  return target;
}

/**
 * Minimal static preview server for a production demo copy. `.map` files
 * are NEVER served (the worker's uploaded maps are the only map source —
 * RS-11 correctness), everything else is served with a proper content
 * type so Chromium executes the minified bundle.
 */
async function serveDist(root: string, port: number): Promise<Server> {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
  };
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
        if (rel === "") {
          rel = "index.html";
        }
        if (rel.endsWith(".map")) {
          res.statusCode = 404;
          res.end("source maps are not served");
          return;
        }
        const full = resolve(root, rel);
        const outside =
          relative(root, full) === "" ||
          relative(root, full).startsWith("..") ||
          isAbsolute(relative(root, full));
        if (outside) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const info = await stat(full).catch(() => null);
        const file =
          info !== null && info.isDirectory() ? join(full, "index.html") : full;
        const bytes = await readFile(file);
        res.setHeader(
          "content-type",
          types[extname(file)] ?? "application/octet-stream",
        );
        res.statusCode = 200;
        res.end(bytes);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });
  return server;
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

let worker: ChildProcess | null = null;
let workerOutput = "";

test.beforeAll(async () => {
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(
      `Worker build missing at ${WORKER_ENTRY}. Run "pnpm build" before this E2E.`,
    );
  }
  workerOutput = "";
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      REPLAYBUG_DATABASE_URL: DB_URL,
      REPLAYBUG_ARTIFACT_DIR: ARTIFACT_DIR,
      REPLAYBUG_OUTBOX_POLL_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker = child;
  child.stdout?.on("data", (chunk: Buffer) => {
    workerOutput += chunk.toString("utf8");
    if (workerOutput.length > 200_000) {
      workerOutput = workerOutput.slice(-100_000);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    workerOutput += chunk.toString("utf8");
    if (workerOutput.length > 200_000) {
      workerOutput = workerOutput.slice(-100_000);
    }
  });
  await pollUntil(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Worker exited during startup.\n${workerOutput.slice(-4000)}`,
        );
      }
      return workerOutput.includes("ReplayBug worker started") ? true : null;
    },
    60_000,
    "worker startup",
    250,
  );
});

test.afterAll(async () => {
  const child = worker;
  worker = null;
  if (child !== null && child.exitCode === null) {
    const exited = new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    });
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
    ]);
  }
});

// ---------------------------------------------------------------------------
// event / issue row access (project-scoped; no global DB resets in this file)
// ---------------------------------------------------------------------------

interface EventSymRow {
  id: string;
  processing_state: string;
  fingerprint: string | null;
  issue_id: string | null;
  release: string | null;
  symbolication_json: unknown;
  payload_json: unknown;
}

interface IssueCountRow {
  id: string;
  fingerprint: string;
  occurrence_count: number;
  affected_session_count: number;
}

async function fetchLatestEvent(
  projectId: string,
  release: string,
): Promise<EventSymRow | null> {
  const rows = await queryRows<EventSymRow>(
    `SELECT id, processing_state, fingerprint, issue_id, release,
            symbolication_json, payload_json
     FROM events WHERE project_id = $1 AND release = $2
       AND event_type = 'exception'
     ORDER BY received_at DESC LIMIT 1`,
    [projectId, release],
  );
  return rows[0] ?? null;
}

async function waitProcessedEvent(
  projectId: string,
  release: string,
): Promise<EventSymRow> {
  return pollUntil(
    async () => {
      const event = await fetchLatestEvent(projectId, release);
      return event !== null && event.processing_state === "processed"
        ? event
        : null;
    },
    180_000,
    `processed event for release ${release}`,
  );
}

async function fetchIssues(projectId: string): Promise<IssueCountRow[]> {
  return queryRows<IssueCountRow>(
    `SELECT id, fingerprint, occurrence_count, affected_session_count
     FROM issues WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
}

interface CheckedSymbolication {
  status: string;
  rawFilename: string;
  rawLine: number;
  rawCol: number;
  mappedSource: string;
  mappedLine: number;
  mappedCol: number;
  mappedName: string;
}

/** Narrow the worker's symbolication JSON and return the head raw/mapped pair. */
function checkSymbolication(value: unknown): CheckedSymbolication {
  if (!isRecord(value)) {
    throw new Error("symbolication_json is not an object");
  }
  const statusValue = value["status"];
  if (typeof statusValue !== "string") {
    throw new Error("symbolication_json has no string status");
  }
  const raw = asArray(value["rawFrames"])[0];
  const mapped = asArray(value["mappedFrames"])[0];
  if (!isRecord(raw) || !isRecord(mapped)) {
    throw new Error("symbolication frames are not objects");
  }
  const rawFilename = raw["filename"];
  const mappedSource = mapped["source"];
  const mappedLine = mapped["line"];
  const mappedCol = mapped["column"];
  const mappedName = mapped["name"];
  if (
    typeof rawFilename !== "string" ||
    typeof mappedSource !== "string" ||
    typeof mappedLine !== "number" ||
    typeof mappedCol !== "number"
  ) {
    throw new Error("symbolication frame shape is unexpected");
  }
  const rawLine = raw["lineno"];
  const rawCol = raw["colno"];
  if (typeof rawLine !== "number" || typeof rawCol !== "number") {
    throw new Error("raw frame coordinates are not numbers");
  }
  return {
    status: statusValue,
    rawFilename,
    rawLine,
    rawCol,
    mappedSource,
    mappedLine,
    mappedCol,
    mappedName: typeof mappedName === "string" ? mappedName : "",
  };
}

function rawPayloadFilename(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error("payload_json is not an object");
  }
  const values = asArray(payload["values"])[0];
  if (!isRecord(values)) {
    throw new Error("payload values are not objects");
  }
  const trace = values["stacktrace"];
  if (!isRecord(trace)) {
    throw new Error("payload has no stacktrace object");
  }
  const frame = asArray(trace["frames"])[0];
  if (!isRecord(frame)) {
    throw new Error("payload frames are not objects");
  }
  const filename = frame["filename"];
  if (typeof filename !== "string") {
    throw new Error("payload frame has no filename");
  }
  return filename;
}

// ---------------------------------------------------------------------------
// E2E-RS12-1 FULL source-map flow
// ---------------------------------------------------------------------------

test("E2E-RS12-1 full source-map flow: CLI upload, minified error, mapped issue and dashboard", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerViaUI(page, uniqueEmail("rs12full"), "RS12 Full");
  const projectId = await onboardProject(page, "RS12 WS", "rs12-full");
  const { dsn } = await rotateDsn(page.request, projectId);
  await addOrigin(page.request, projectId, DEMO_ORIGIN);
  await configureEnvironmentBaseUrl(page.request, projectId);
  const created = await createSecretToken(
    page.request,
    projectId,
    "e2e-full-flow",
  );
  const version = uniqueVersion("e2e-full");

  // Real CLI boundary: projects info → releases create → sourcemaps upload.
  const info = await runCli(["projects", "info", "--json"], {
    REPLAYBUG_AUTH_TOKEN: created.token,
  });
  expect(info.code).toBe(0);
  expect(lacksSecret(info.stdout + info.stderr, created.token)).toBe(true);
  expect(
    strField(
      parseJsonObject(info.stdout)["project"] as Record<string, unknown>,
      "id",
    ),
  ).toBe(projectId);

  const mk = await runCli(["releases", "create", version, "--json"], {
    REPLAYBUG_AUTH_TOKEN: created.token,
  });
  expect(mk.code).toBe(0);
  expect(lacksSecret(mk.stdout + mk.stderr, created.token)).toBe(true);
  const mkBody = parseJsonObject(mk.stdout);
  expect(mkBody["created"]).toBe(true);
  expect(
    strField(mkBody["release"] as Record<string, unknown>, "version"),
  ).toBe(version);

  // Fresh MINIFIED production demo with the exact DSN + release baked in.
  const distDir = await buildDemoDist(dsn, version);
  try {
    const up = await runCli(
      ["sourcemaps", "upload", distDir, "--release", version, "--json"],
      { REPLAYBUG_AUTH_TOKEN: created.token },
    );
    expect(up.code).toBe(0);
    expect(lacksSecret(up.stdout + up.stderr, created.token)).toBe(true);
    const summary = parseJsonObject(up.stdout);
    expect(
      numField(summary["found"] as Record<string, unknown>, "sourceMaps"),
    ).toBeGreaterThanOrEqual(1);
    expect(numField(summary, "uploaded")).toBeGreaterThanOrEqual(2);

    const server = await serveDist(distDir, DEMO_PORT);
    try {
      await page.goto(DEMO_ORIGIN);
      await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
        "Enabled",
        { timeout: 30_000 },
      );
      const expectedPageError =
        "DEMO: Minified release error is unreachable (lines=0)";
      let pageError: Error | null = null;
      const onPageError = (error: Error): void => {
        pageError ??= error;
      };
      page.on("pageerror", onPageError);
      try {
        await page.getByTestId(SCENARIO_TEST_ID).click();
        await expect.poll(() => pageError?.message).toBe(expectedPageError);
      } finally {
        page.off("pageerror", onPageError);
      }
      await expect(page.getByText(/Minified release error armed…/)).toBeVisible(
        {
          timeout: 30_000,
        },
      );

      const event = await waitProcessedEvent(projectId, version);
      expect(event.issue_id).not.toBeNull();
      expect(event.fingerprint ?? "").toMatch(/^[0-9a-f]{64}$/);
      const checked = checkSymbolication(event.symbolication_json);
      expect(
        checked.status === "mapped" || checked.status === "partially_mapped",
      ).toBe(true);
      // Mapped source is the ORIGINAL file, never the minified asset.
      expect(checked.mappedSource.endsWith(SCENARIO_SOURCE_SUFFIX)).toBe(true);
      expect(checked.mappedSource).not.toBe(checked.rawFilename);
      expect(checked.mappedLine).toBeGreaterThanOrEqual(40);
      expect(checked.mappedLine).toBeLessThanOrEqual(50);
      // Raw frame still names the minified hashed bundle with real coords.
      expect(checked.rawFilename).toContain("assets/index-");
      expect(checked.rawFilename.endsWith(".js")).toBe(true);
      expect(checked.rawLine).toBeGreaterThanOrEqual(1);
      expect(checked.rawCol).toBeGreaterThanOrEqual(1);
      // Raw ingest payload is intact (worker enriches, never overwrites).
      expect(rawPayloadFilename(event.payload_json)).toBe(checked.rawFilename);

      const reproductionCreate = await page.request.post(
        `${API}/api/v1/events/${event.id}/reproductions`,
        {
          headers: {
            "Idempotency-Key": `rs12-reproduction-${event.id}`,
          },
        },
      );
      expect(reproductionCreate.status()).toBe(202);
      const reproductionCreateBody =
        (await reproductionCreate.json()) as unknown;
      if (!isRecord(reproductionCreateBody)) {
        throw new Error("reproduction create returned a non-object body");
      }
      const reproductionId = strField(reproductionCreateBody, "id");
      expect(reproductionId).not.toBe("");
      expect(["pending", "ready"]).toContain(
        strField(reproductionCreateBody, "status"),
      );
      const reproduction = await pollUntil<Record<string, unknown>>(
        async () => {
          const response = await page.request.get(
            `${API}/api/v1/reproductions/${reproductionId}`,
          );
          if (response.status() !== 200) {
            return null;
          }
          const body = (await response.json()) as unknown;
          return isRecord(body) && body["status"] === "ready" ? body : null;
        },
        120_000,
        `ready reproduction ${reproductionId}`,
      );
      const generatedCode = strField(reproduction, "code");
      const reproductionText = JSON.stringify(reproduction);
      expect(strField(reproduction, "framework")).toBe("playwright");
      expect(strField(reproduction, "language")).toBe("typescript");
      expect(generatedCode.includes(SCENARIO_TEST_ID)).toBe(true);
      expect(/page\.on\((?:'|")pageerror(?:'|")/.test(generatedCode)).toBe(
        true,
      );
      expect(generatedCode.includes(expectedPageError)).toBe(true);
      expect(lacksSecret(reproductionText, created.token)).toBe(true);
      expect(/rb_sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/.test(reproductionText)).toBe(
        false,
      );
      const generatedUrls =
        reproductionText.match(/https?:\/\/[^\s"'`\\]+/g) ?? [];
      expect(generatedUrls.length).toBeGreaterThan(0);
      for (const urlText of generatedUrls) {
        const url = new URL(urlText.replace(/[),.;]+$/, ""));
        expect(["localhost", "127.0.0.1", "::1"]).toContain(url.hostname);
      }
      expect(validateGeneratedSyntax(generatedCode).ok).toBe(true);
      const generatedRun = await runGeneratedTest(generatedCode);
      expect(generatedRun.code).toBe(0);
      expect(
        lacksSecret(generatedRun.stdout + generatedRun.stderr, created.token),
      ).toBe(true);

      await recordEvidence("E2E-RS12-1", {
        release: version,
        status: checked.status,
        fingerprint: event.fingerprint,
        raw: `${checked.rawFilename}:${checked.rawLine}:${checked.rawCol}`,
        mapped: `${checked.mappedSource}:${checked.mappedLine}:${checked.mappedCol} ${checked.mappedName}`,
        issueId: event.issue_id,
      });

      // Release dashboard API: listing + detail render the upload, counts
      // included, storage keys never exposed.
      const listRes = await page.request.get(
        `${API}/api/v1/projects/${projectId}/releases`,
      );
      expect(listRes.status()).toBe(200);
      const listBody = (await listRes.json()) as unknown;
      const listText = JSON.stringify(listBody);
      expect(listText).toContain(version);
      expect(/storage_key|storageKey/i.test(listText)).toBe(false);
      const releases = listBody as Array<Record<string, unknown>>;
      const listed = releases.find((item) => item["version"] === version) as
        Record<string, unknown> | undefined;
      expect(listed !== undefined).toBe(true);
      const releaseId = strField(listed as Record<string, unknown>, "id");

      const detailRes = await page.request.get(
        `${API}/api/v1/projects/${projectId}/releases/${releaseId}`,
      );
      expect(detailRes.status()).toBe(200);
      const detailText = JSON.stringify(await detailRes.json());
      expect(detailText).toContain(".map");
      expect(detailText).toContain(version);
      expect(/storage_key|storageKey/i.test(detailText)).toBe(false);

      // Release dashboard UI: post-upload listing/detail with counts.
      await page.goto(`/app/projects/${projectId}/releases`);
      await expect(page.getByText(version)).toBeVisible({ timeout: 15_000 });
      await page.getByRole("link", { name: version }).click();
      await expect(page).toHaveURL(new RegExp(`/releases/${releaseId}`), {
        timeout: 15_000,
      });
      await expect(page.getByText(".map").first()).toBeVisible({
        timeout: 15_000,
      });

      // Issue UI: mapped by default, Raw toggle intact.
      const issueId = event.issue_id as string;
      await page.goto(`/app/projects/${projectId}/issues/${issueId}`);
      const mappedButton = page.getByRole("button", { name: "Source mapped" });
      await expect(mappedButton).toBeVisible({ timeout: 15_000 });
      await expect(mappedButton).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(/minified-release-error\.ts/)).toBeVisible();
      await page.getByRole("button", { name: "Raw" }).click();
      await expect(page.getByText(/assets\/index-/).first()).toBeVisible();
    } finally {
      await stopServer(server);
    }
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2E-RS12-2 cross-release same-issue grouping
// ---------------------------------------------------------------------------

test("E2E-RS12-2 two production releases with different coords share one mapped issue", async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  await registerViaUI(page, uniqueEmail("rs12xrel"), "RS12 XRel");
  const projectId = await onboardProject(page, "RS12 XRel WS", "rs12-xrel");
  const { dsn } = await rotateDsn(page.request, projectId);
  await addOrigin(page.request, projectId, DEMO_ORIGIN);
  const created = await createSecretToken(page.request, projectId, "e2e-xrel");
  const env = { REPLAYBUG_AUTH_TOKEN: created.token };
  const versionA = uniqueVersion("e2e-xrel-a");
  const versionB = uniqueVersion("e2e-xrel-b");

  // Two genuine production builds: same source, different bundle content
  // (different release strings) → different hashed assets and coords.
  const distA = await buildDemoDist(dsn, versionA);
  const distB = await buildDemoDist(dsn, versionB);
  try {
    for (const version of [versionA, versionB]) {
      const mk = await runCli(["releases", "create", version, "--json"], env);
      expect(mk.code).toBe(0);
    }
    const upA = await runCli(
      ["sourcemaps", "upload", distA, "--release", versionA, "--json"],
      env,
    );
    expect(upA.code).toBe(0);
    const upB = await runCli(
      ["sourcemaps", "upload", distB, "--release", versionB, "--json"],
      env,
    );
    expect(upB.code).toBe(0);
    expect(
      lacksSecret(
        upA.stdout + upA.stderr + upB.stdout + upB.stderr,
        created.token,
      ),
    ).toBe(true);

    const serverA = await serveDist(distA, DEMO_PORT);
    try {
      await page.goto(DEMO_ORIGIN);
      await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
        "Enabled",
        { timeout: 30_000 },
      );
      const expectedPageError =
        "DEMO: Minified release error is unreachable (lines=0)";
      let pageError: Error | null = null;
      const onPageError = (error: Error): void => {
        pageError ??= error;
      };
      page.on("pageerror", onPageError);
      try {
        await page.getByTestId(SCENARIO_TEST_ID).click();
        await expect(
          page.getByText(/Minified release error armed…/),
        ).toBeVisible({
          timeout: 30_000,
        });
        await expect.poll(() => pageError?.message).toBe(expectedPageError);
      } finally {
        page.off("pageerror", onPageError);
      }
    } finally {
      await stopServer(serverA);
    }
    const eventA = await waitProcessedEvent(projectId, versionA);

    // Second release, fresh browser context (a distinct telemetry session).
    const context = await browser.newContext();
    const pageB = await context.newPage();
    const serverB = await serveDist(distB, DEMO_PORT);
    try {
      await pageB.goto(DEMO_ORIGIN);
      await expect(pageB.locator("p:has-text('Telemetry:')")).toContainText(
        "Enabled",
        { timeout: 30_000 },
      );
      const expectedPageError =
        "DEMO: Minified release error is unreachable (lines=0)";
      let pageError: Error | null = null;
      const onPageError = (error: Error): void => {
        pageError ??= error;
      };
      pageB.on("pageerror", onPageError);
      try {
        await pageB.getByTestId(SCENARIO_TEST_ID).click();
        await expect(
          pageB.getByText(/Minified release error armed…/),
        ).toBeVisible({
          timeout: 30_000,
        });
        await expect.poll(() => pageError?.message).toBe(expectedPageError);
      } finally {
        pageB.off("pageerror", onPageError);
      }
    } finally {
      await stopServer(serverB);
      await context.close();
    }
    const eventB = await waitProcessedEvent(projectId, versionB);

    const checkedA = checkSymbolication(eventA.symbolication_json);
    const checkedB = checkSymbolication(eventB.symbolication_json);
    expect(
      checkedA.status === "mapped" || checkedA.status === "partially_mapped",
    ).toBe(true);
    expect(
      checkedB.status === "mapped" || checkedB.status === "partially_mapped",
    ).toBe(true);
    // Different generated coords (different hashed bundles)…
    expect(checkedA.rawFilename).not.toBe(checkedB.rawFilename);
    // …same original source…
    expect(checkedA.mappedSource.endsWith(SCENARIO_SOURCE_SUFFIX)).toBe(true);
    expect(checkedB.mappedSource).toBe(checkedA.mappedSource);
    expect(checkedB.mappedLine).toBe(checkedA.mappedLine);
    // …same fingerprint, one issue, two occurrences.
    expect(eventA.fingerprint).not.toBeNull();
    expect(eventB.fingerprint).toBe(eventA.fingerprint);

    const issues = await pollUntil(
      async () => {
        const rows = await fetchIssues(projectId);
        return rows.length === 1 && rows[0]?.occurrence_count === 2
          ? rows
          : null;
      },
      120_000,
      "single cross-release issue with 2 occurrences",
    );
    expect(issues[0]?.affected_session_count).toBe(2);

    await recordEvidence("E2E-RS12-2", {
      releases: [versionA, versionB],
      fingerprint: eventA.fingerprint,
      rawA: `${checkedA.rawFilename}:${checkedA.rawLine}:${checkedA.rawCol}`,
      rawB: `${checkedB.rawFilename}:${checkedB.rawLine}:${checkedB.rawCol}`,
      mapped: `${checkedA.mappedSource}:${checkedA.mappedLine}:${checkedA.mappedCol}`,
      occurrenceCount: issues[0]?.occurrence_count,
    });
  } finally {
    await rm(distA, { recursive: true, force: true });
    await rm(distB, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2E-RS12-3 missing source map
// ---------------------------------------------------------------------------

test("E2E-RS12-3 release without an uploaded map degrades to raw with map_not_found", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await registerViaUI(page, uniqueEmail("rs12nomap"), "RS12 NoMap");
  const projectId = await onboardProject(page, "RS12 NoMap WS", "rs12-nomap");
  const { dsn } = await rotateDsn(page.request, projectId);
  await addOrigin(page.request, projectId, DEMO_ORIGIN);
  const created = await createSecretToken(page.request, projectId, "e2e-nomap");
  const version = uniqueVersion("e2e-nomap");

  const mk = await runCli(["releases", "create", version, "--json"], {
    REPLAYBUG_AUTH_TOKEN: created.token,
  });
  expect(mk.code).toBe(0);

  // Deliberately NO sourcemaps upload for this release.
  const distDir = await buildDemoDist(dsn, version);
  try {
    const server = await serveDist(distDir, DEMO_PORT);
    try {
      await page.goto(DEMO_ORIGIN);
      await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
        "Enabled",
        { timeout: 30_000 },
      );
      await page.getByTestId(SCENARIO_TEST_ID).click();
      await expect(page.getByText(/Minified release error armed…/)).toBeVisible(
        {
          timeout: 30_000,
        },
      );

      const event = await waitProcessedEvent(projectId, version);
      expect(event.issue_id).not.toBeNull();
      const sym = event.symbolication_json;
      if (!isRecord(sym)) {
        throw new Error("symbolication_json is not an object");
      }
      expect(sym["status"]).toBe("map_not_found");
      expect(asArray(sym["rawFrames"]).length).toBeGreaterThan(0);
      // Misses echo pass-through frames with mapped:false; nothing resolved.
      expect(sym["mappedFrameCount"]).toBe(0);
      for (const frame of asArray(sym["mappedFrames"])) {
        expect(isRecord(frame) && frame["mapped"]).toBe(false);
      }

      const issues = await fetchIssues(projectId);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.occurrence_count).toBe(1);

      await recordEvidence("E2E-RS12-3", {
        release: version,
        status: sym["status"],
        issueId: event.issue_id,
      });

      // Honest dashboard state: raw shown, no mapped toggle, no crash.
      const issueId = event.issue_id as string;
      await page.goto(`/app/projects/${projectId}/issues/${issueId}`);
      await expect(page.getByText(/Raw stack trace/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText(/source map unavailable/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Source mapped" }),
      ).toHaveCount(0);
    } finally {
      await stopServer(server);
    }
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }

  // No worker poison: the shared worker is still alive for later tests.
  expect(worker?.exitCode).toBeNull();
});

// ---------------------------------------------------------------------------
// E2E-RS12-4 revoked secret token
// ---------------------------------------------------------------------------

const REVOKED_MAP = JSON.stringify({
  version: 3,
  sources: ["../src/app.ts"],
  names: ["init", "render"],
  mappings: "AAAAA,UASKC",
});
const REVOKED_MINIFIED = "var a=1;\n//# sourceMappingURL=app.js.map\n";

test("E2E-RS12-4 revoked token: CLI 401s, releases and artifacts stay intact and worker-readable", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await registerViaUI(page, uniqueEmail("rs12rev"), "RS12 Revoked");
  const projectId = await onboardProject(page, "RS12 Rev WS", "rs12-revoked");
  const { publicKey } = await rotateDsn(page.request, projectId);
  await addOrigin(page.request, projectId, DEMO_ORIGIN);
  const created = await createSecretToken(
    page.request,
    projectId,
    "e2e-revoke",
  );
  const env = { REPLAYBUG_AUTH_TOKEN: created.token };
  const version = uniqueVersion("e2e-revoked");

  // Token works: info + release create.
  const info = await runCli(["projects", "info", "--json"], env);
  expect(info.code).toBe(0);
  expect(lacksSecret(info.stdout + info.stderr, created.token)).toBe(true);

  // Upload a small genuine fixture dir (map + sibling minified asset) so the
  // worker has real artifacts to read after revocation.
  const fixtureDir = await mkdtemp(join(tmpdir(), "rs12-revoked-fixture-"));
  try {
    await mkdir(join(fixtureDir, "assets"), { recursive: true });
    await writeFile(
      join(fixtureDir, "assets", "app.js"),
      REVOKED_MINIFIED,
      "utf8",
    );
    await writeFile(
      join(fixtureDir, "assets", "app.js.map"),
      REVOKED_MAP,
      "utf8",
    );

    const mk = await runCli(["releases", "create", version, "--json"], env);
    expect(mk.code).toBe(0);
    const up = await runCli(
      ["sourcemaps", "upload", fixtureDir, "--release", version, "--json"],
      env,
    );
    expect(up.code).toBe(0);
    expect(numField(parseJsonObject(up.stdout), "uploaded")).toBe(2);

    // Revoke via the dashboard management path, then the CLI must 401.
    await revokeSecretToken(page.request, projectId, created.id);

    const denied = await runCli(["projects", "info", "--json"], env);
    expect(denied.code).not.toBe(0);
    expect(lacksSecret(denied.stdout + denied.stderr, created.token)).toBe(
      true,
    );
    expect(
      /401|AUTH_REQUIRED|Authentication required/.test(
        denied.stdout + denied.stderr,
      ),
    ).toBe(true);

    const deniedUpload = await runCli(
      ["sourcemaps", "upload", fixtureDir, "--release", version, "--json"],
      env,
    );
    expect(deniedUpload.code).not.toBe(0);
    expect(
      lacksSecret(deniedUpload.stdout + deniedUpload.stderr, created.token),
    ).toBe(true);

    // Releases + artifacts are intact via the dashboard API (no storage keys).
    const listRes = await page.request.get(
      `${API}/api/v1/projects/${projectId}/releases`,
    );
    expect(listRes.status()).toBe(200);
    const listBody = (await listRes.json()) as unknown;
    const listText = JSON.stringify(listBody);
    expect(listText).toContain(version);
    expect(/storage_key|storageKey/i.test(listText)).toBe(false);
    const releases = listBody as Array<Record<string, unknown>>;
    const listed = releases.find((item) => item["version"] === version);
    if (listed === undefined) {
      throw new Error("revoked release missing from dashboard listing");
    }
    const detailRes = await page.request.get(
      `${API}/api/v1/projects/${projectId}/releases/${strField(listed, "id")}`,
    );
    expect(detailRes.status()).toBe(200);
    const detailText = JSON.stringify(await detailRes.json());
    expect(detailText).toContain("assets/app.js.map");
    expect(detailText).toContain("assets/app.js");

    // Uploaded artifacts are still worker-readable: ingest a matching
    // minified exception via the public path and expect genuine mapping.
    const batch = {
      protocol_version: 1,
      sdk_name: "@replaybug/sdk",
      sdk_version: "0.2.0",
      session: {
        sdk_session_id: `rs12-revoked-${Date.now()}`,
        browser: {
          name: "chromium",
          version: "120.0",
          os_name: "Windows",
          os_version: "11",
          device_type: "desktop",
          viewport_width: 1280,
          viewport_height: 720,
        },
        initial_url: `${DEMO_ORIGIN}/`,
        environment: "production",
        release: version,
      },
      events: [
        {
          event_id: `revoked-evt-${Date.now()}`,
          sequence_number: 0,
          event_type: "exception",
          timestamp: new Date().toISOString(),
          payload: {
            values: [
              {
                type: "TypeError",
                value: "Cannot read properties of null (reading 'total')",
                stacktrace: {
                  frames: [
                    {
                      filename: `${DEMO_ORIGIN}/assets/app.js`,
                      function: "a",
                      lineno: 1,
                      colno: 11,
                      in_app: true,
                    },
                  ],
                },
                mechanism: { type: "generic", handled: false },
              },
            ],
          },
        },
      ],
    };
    const ingestRes = await page.request.post(`${API}/api/ingest/v1/batch`, {
      headers: { "x-replaybug-key": publicKey, origin: DEMO_ORIGIN },
      data: batch,
    });
    expect(ingestRes.status()).toBe(200);

    const event = await waitProcessedEvent(projectId, version);
    const checked = checkSymbolication(event.symbolication_json);
    expect(checked.status).toBe("mapped");
    expect(checked.mappedSource).toBe("src/app.ts");

    await recordEvidence("E2E-RS12-4", {
      release: version,
      deniedCode: denied.code,
      status: checked.status,
      mapped: `${checked.mappedSource}:${checked.mappedLine}:${checked.mappedCol}`,
    });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2E-RS12-5 secret-token UI gaps: copy, reload hygiene, viewer restrictions
// ---------------------------------------------------------------------------

test("E2E-RS12-5 token UI: copy works, plaintext never persists, viewer restricted, releases readable", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await registerViaUI(page, uniqueEmail("rs12tokui"), "RS12 TokUI");
  const projectId = await onboardProject(page, "RS12 TokUI WS", "rs12-tokui");

  await page.goto(`/app/projects/${projectId}/settings/keys`);
  await expect(
    page.getByRole("heading", { name: "Secret project tokens" }),
  ).toBeVisible({ timeout: 15_000 });

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByLabel("Token name").fill("ui-copy");
  await page.getByRole("button", { name: "Create secret token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("shown once")).toBeVisible({ timeout: 15_000 });
  const tokenText = (await dialog.locator("code").textContent()) ?? "";
  expect(isSecretTokenShape(tokenText)).toBe(true);

  // Copy affordance actually works.
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible({
    timeout: 15_000,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // Plaintext never persists: DOM, storage, URL — including after reopen.
  await expect(page.getByText(tokenText)).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Secret project tokens" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(tokenText)).toHaveCount(0, { timeout: 15_000 });
  const leaked = await page.evaluate((token) => {
    const dump: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) {
        dump.push(localStorage.getItem(key) ?? "");
      }
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key !== null) {
        dump.push(sessionStorage.getItem(key) ?? "");
      }
    }
    return {
      inStorage: dump.some((v) => v.includes(token)),
      inUrl: window.location.href.includes(token),
    };
  }, tokenText);
  expect(leaked).toEqual({ inStorage: false, inUrl: false });

  // Owner revokes from the same UI.
  await page.getByRole("button", { name: "Revoke token ui-copy" }).click();
  await expect(page.getByText("Revoked")).toBeVisible({ timeout: 15_000 });

  // A release created by the owner stays readable for low-privilege roles.
  const ownerToken = await createSecretToken(
    page.request,
    projectId,
    "owner-rel",
  );
  const viewerVersion = uniqueVersion("e2e-viewer");
  const mk = await runCli(["releases", "create", viewerVersion, "--json"], {
    REPLAYBUG_AUTH_TOKEN: ownerToken.token,
  });
  expect(mk.code).toBe(0);

  // Viewer: same 403-on-all restricted notice, no create/revoke controls.
  const viewerEmail = uniqueEmail("rs12viewer");
  expect(await signupViaApi(viewerEmail)).toBe(true);
  const projRows = await queryRows<{ workspace_id: string }>(
    `SELECT workspace_id FROM projects WHERE id = $1`,
    [projectId],
  );
  const workspaceId = projRows[0]?.workspace_id;
  if (typeof workspaceId !== "string") {
    throw new Error("project workspace lookup failed");
  }
  const userRows = await queryRows<{ id: string }>(
    `SELECT id FROM "user" WHERE email = $1`,
    [viewerEmail],
  );
  const viewerId = userRows[0]?.id;
  if (typeof viewerId !== "string") {
    throw new Error("viewer user lookup failed");
  }
  await queryRows(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
    [workspaceId, viewerId],
  );

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(viewerEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

  await page.goto(`/app/projects/${projectId}/settings/keys`);
  await expect(page.getByText("restricted")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Token name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Revoke token/ })).toHaveCount(
    0,
  );

  await page.goto(`/app/projects/${projectId}/releases`);
  await expect(page.getByText(viewerVersion)).toBeVisible({ timeout: 15_000 });
});
