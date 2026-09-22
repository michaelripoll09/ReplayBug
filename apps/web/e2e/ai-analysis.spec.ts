import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  test,
  expect,
  request,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Pool, type QueryResultRow } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";
import {
  MALFORMED_CONTENT,
  MockOllamaServer,
  PROVIDER_SENTINEL,
  WRONG_SCHEMA_CONTENT,
  asChatBody,
  extractEvidenceBundle,
  type MockOllamaEvidenceBundle,
} from "./mock-ollama";

/**
 * Block 10 AI E2E on the real stack (real PostgreSQL + real API + real
 * worker + real web + real demo app + an ephemeral mock Ollama server).
 *
 * Every scenario runs the product path; only the model provider is mocked,
 * on an ephemeral loopback port that speaks the real Ollama `/api/chat`
 * contract. The mock captures the full outbound request body so this suite
 * can assert the exact evidence whitelist and its privacy exclusions, which
 * no unit test can prove end-to-end.
 *
 * Scenarios:
 * 1. mandatory happy path: request → pending → worker → SSE ready without
 *    reload → panel/evidence/notification, outbound privacy, outbox
 *    dispatch, idempotent replay, second immutable analysis.
 * 2. viewer: reads history, no request controls, direct POST is 403.
 * 3. degraded provider: timeout, malformed JSON, unknown refs, 500, 429 —
 *    bounded safe failures and a worker that keeps processing other jobs.
 * 4. provider down during an outage: safe failure + failure notification,
 *    while issue ingest and deterministic Playwright reproduction still
 *    generate and execute a PASS.
 * 5. AI disabled stack: real disabled capability + POST
 *    `AI_NOT_CONFIGURED`, and the disabled panel state.
 *
 * Bounded waits only, zero skips. Requires built API/worker (`pnpm build`)
 * and the Block 10 migration applied (`pnpm db:migrate`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const API = "http://localhost:4001";
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
const DEMO_PORT = 5194;
const DEMO_URL = `http://localhost:${DEMO_PORT}`;
const DEMO_ORIGIN = DEMO_URL;
const WORKER_ENTRY = join(ROOT, "apps", "worker", "dist", "index.js");
const API_ENTRY = join(ROOT, "apps", "api", "dist", "server.js");
// Must stay in sync with playwright.config.ts: the API reports this model in
// its capability DTO and persists it on every analysis row, while the worker
// sends the same name to the provider.
const E2E_OLLAMA_MODEL = "e2e-mock-ollama";
const DISCLAIMER =
  "AI-generated hypothesis based on captured telemetry. It may be wrong.";
const NAV_CLICK_MESSAGE = "DEMO: Error after navigation and click";
const UNCAUGHT_MESSAGE = "DEMO: Uncaught error after navigation and click";
const MOCK_SUMMARY =
  "E2E mock summary: the checkout handler dereferenced a null product.";
const MOCK_CAUSE =
  "E2E mock suspected cause: the demo failure happens after the navigation click.";
const MOCK_STEP = "E2E mock step: open the demo page and click the control.";
const MOCK_LIMITATION = "E2E mock limitation: telemetry evidence only.";
const MOCK_HOSTILE =
  '<img src=x onerror="window.__aiXss=1">E2E mock hostile text';
const SECRET_FIXTURE = "e2e-secret-fixture-7c1-DO-NOT-SEND";
const COMMENT_MARKER = "E2E-INTERNAL-COMMENT-MARKER-7c1";
const DEMO_JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

test.setTimeout(600_000);
// Tracing is off for this file: the outage scenario spawns a nested
// Playwright run inside the test, and on Windows the outer trace
// finalization races with the nested browser, masking real results as
// teardown failures (same reason as e2e/reproduction.spec.ts).
test.use({ trace: "off" });

let mock: MockOllamaServer;
let worker: SpawnedProcess | null = null;
let demo: SpawnedProcess | null = null;
let demoContext: BrowserContext | null = null;
let apiCtx: APIRequestContext;
let ownerEmail = "";
let ownerCookies = "";
let projectId = "";
let publicKey = "";
/** Issue created from the repeated navigation-click capture (2 occurrences). */
let navClickIssueId = "";
let selectedEventId = "";
/** Issue created by the outage scenario; reused by the disabled scenario. */
let outageIssueId = "";
/** Ready analysis created by the happy path; later asserted as immutable. */
let readyAnalysisId = "";
let firstReadySnapshot: Record<string, unknown> | null = null;

function db(): Pool {
  return new Pool({ connectionString: DB_URL });
}

async function queryRows<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const pool = db();
  try {
    const result = await pool.query<T>(sql, [...params]);
    return result.rows;
  } finally {
    await pool.end();
  }
}

/**
 * Single explicit json narrowing point: Playwright's `APIResponse.json()`
 * is typed as `Promise<any>`, so every read goes through `unknown` instead
 * of leaking `any` into the assertions.
 */
async function readJson<T>(response: {
  json: () => Promise<unknown>;
}): Promise<T> {
  return (await response.json()) as T;
}

/** Bounded poll; resolves with the first non-null probe value. */
async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

/** A free ephemeral loopback port, released before the caller binds it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("free port probe failed");
  }
  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

/** Base URL of a loopback port nothing listens on (provider down). */
async function closedPortUrl(): Promise<string> {
  return `http://127.0.0.1:${String(await freePort())}`;
}

interface SpawnedProcess {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

function spawnTracked(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
): SpawnedProcess {
  let output = "";
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.on("error", (error: Error) => {
    console.log(`[spawn-error] ${command} cwd=${opts.cwd}: ${error.message}`);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return {
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

interface WorkerOptions {
  /** `REPLAYBUG_OLLAMA_URL` for this worker process. */
  ollamaUrl: string;
  timeoutMs?: number;
  retryLimit?: number;
}

async function startWorker(options: WorkerOptions): Promise<SpawnedProcess> {
  const proc = spawnTracked(process.execPath, [WORKER_ENTRY], {
    cwd: join(ROOT, "apps", "worker"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      REPLAYBUG_DATABASE_URL: DB_URL,
      REPLAYBUG_OUTBOX_POLL_MS: "200",
      REPLAYBUG_JOB_POLL_MS: "500",
      REPLAYBUG_REPRODUCTION_OUTBOX_POLL_MS: "200",
      REPLAYBUG_REPRODUCTION_OUTBOX_BATCH_SIZE: "100",
      REPLAYBUG_OLLAMA_URL: options.ollamaUrl,
      REPLAYBUG_OLLAMA_MODEL: E2E_OLLAMA_MODEL,
      REPLAYBUG_OLLAMA_TIMEOUT_MS: String(options.timeoutMs ?? 15_000),
      ...(options.retryLimit === undefined
        ? {}
        : { REPLAYBUG_JOB_RETRY_LIMIT: String(options.retryLimit) }),
    },
  });
  await pollUntil(
    async () => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        throw new Error(`worker exited during startup.\n${proc.output()}`);
      }
      return proc.output().includes("ReplayBug worker started") ? true : null;
    },
    60_000,
    250,
  );
  return proc;
}

/** Swaps the running worker for one with different provider settings. */
async function restartWorker(options: WorkerOptions): Promise<void> {
  await worker?.stop();
  worker = null;
  worker = await startWorker(options);
}

async function startDemo(dsn: string): Promise<SpawnedProcess> {
  const require = createRequire(join(ROOT, "apps", "demo", "package.json"));
  const viteBin = join(
    dirname(require.resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  const proc = spawnTracked(
    process.execPath,
    [viteBin, "--port", String(DEMO_PORT), "--strictPort"],
    {
      cwd: join(ROOT, "apps", "demo"),
      env: {
        ...process.env,
        VITE_REPLAYBUG_DSN: dsn,
        VITE_REPLAYBUG_ENVIRONMENT: "production",
        VITE_REPLAYBUG_RELEASE: "demo-ai-e2e@0.1.0",
      },
    },
  );
  await pollUntil(
    async () => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        throw new Error(`demo exited during startup.\n${proc.output()}`);
      }
      const text = proc.output();
      return text.includes(`localhost:${DEMO_PORT}`) ||
        text.includes("ready in")
        ? true
        : null;
    },
    90_000,
    500,
  );
  return proc;
}

/** AI-disabled API instance: no `REPLAYBUG_OLLAMA_*` in the environment. */
async function startApiWithoutOllama(): Promise<
  SpawnedProcess & { url: string }
> {
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    REPLAYBUG_API_PORT: String(port),
    REPLAYBUG_DATABASE_URL: DB_URL,
    REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
    REPLAYBUG_WEB_URL: "http://localhost:3000",
    REPLAYBUG_API_URL: `http://localhost:${String(port)}`,
    REPLAYBUG_TRUSTED_ORIGINS: "http://localhost:3000",
    REPLAYBUG_USER_HMAC_SECRET: "test-hmac-secret-0123456789abcdef0123456789",
    REPLAYBUG_ARTIFACT_DIR: join(tmpdir(), "replaybug-web-e2e-artifacts"),
  };
  delete env["REPLAYBUG_OLLAMA_URL"];
  delete env["REPLAYBUG_OLLAMA_MODEL"];
  delete env["REPLAYBUG_OLLAMA_TIMEOUT_MS"];
  const proc = spawnTracked(process.execPath, [API_ENTRY], {
    cwd: join(ROOT, "apps", "api"),
    env,
  });
  const url = `http://127.0.0.1:${String(port)}`;
  const probe = await request.newContext({ baseURL: url });
  try {
    await pollUntil(
      async () => {
        if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
          throw new Error(
            `AI-disabled API exited during startup.\n${proc.output()}`,
          );
        }
        const res = await probe.get("/api/v1/meta").catch(() => null);
        return res !== null && res.ok() ? true : null;
      },
      60_000,
      250,
    );
  } finally {
    await probe.dispose();
  }
  return { ...proc, url };
}

async function registerViaUI(
  page: Page,
  email: string,
  name: string,
): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });
}

async function onboardProjectWithKey(
  page: Page,
  workspaceName: string,
  projectName: string,
): Promise<{ projectId: string; publicKey: string }> {
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });
  await page.getByLabel("Project name").fill(projectName);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("Copy your public ingest key")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Reveal secret" }).click();
  const keyCode = page.locator("code").first();
  const publicKey = ((await keyCode.textContent()) ?? "").trim();
  expect(publicKey).toMatch(/^rb_pk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  await page
    .getByRole("button", { name: "I copied the key — continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/origin/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding\/complete/, { timeout: 15_000 });
  const projectId = new URL(page.url()).searchParams.get("projectId") ?? "";
  expect(projectId).not.toBe("");
  return { projectId, publicKey };
}

async function loginViaUI(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

async function openIssue(page: Page, issueId: string): Promise<void> {
  await page.goto(`/app/projects/${projectId}/issues/${issueId}`);
  await expect(page.locator("#ai-analysis")).toBeVisible({ timeout: 30_000 });
}

function cookiesFromHeaders(
  headers: Array<{ name: string; value: string }>,
): string {
  return headers
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0] ?? "")
    .filter((part) => part !== "")
    .join("; ");
}

async function signInAs(email: string): Promise<{
  ctx: APIRequestContext;
  cookies: string;
}> {
  const ctx = await request.newContext({ baseURL: API });
  const signin = await ctx.post("/api/auth/sign-in/email", {
    data: { email, password: E2E_PASSWORD },
  });
  if (!signin.ok()) {
    throw new Error(`sign-in failed for ${email}: ${signin.status()}`);
  }
  return { ctx, cookies: cookiesFromHeaders(await signin.headersArray()) };
}

interface EnvironmentItem {
  id: string;
  name: string;
  baseUrl: string | null;
  isDefault: boolean;
}

async function configureEnvironmentBaseUrl(
  ctx: APIRequestContext,
  cookies: string,
  baseUrl: string,
): Promise<void> {
  const listRes = await ctx.get(`/api/v1/projects/${projectId}/environments`, {
    headers: { cookie: cookies },
  });
  if (!listRes.ok()) {
    throw new Error(`list environments failed: ${listRes.status()}`);
  }
  const items = await readJson<EnvironmentItem[]>(listRes);
  const target =
    items.find((e) => e.isDefault) ??
    items.find((e) => e.name === "production") ??
    items[0];
  if (target === undefined) {
    throw new Error("project has no environment to configure");
  }
  const patchRes = await ctx.patch(`/api/v1/environments/${target.id}`, {
    headers: { cookie: cookies },
    data: { baseUrl },
  });
  if (!patchRes.ok()) {
    throw new Error(`patch environment failed: ${patchRes.status()}`);
  }
}

async function addProjectOrigin(
  ctx: APIRequestContext,
  cookies: string,
  origin: string,
): Promise<void> {
  const res = await ctx.post(`/api/v1/projects/${projectId}/origins`, {
    headers: { cookie: cookies },
    data: { origin },
  });
  if (!res.ok()) {
    throw new Error(`add origin failed: ${res.status()}`);
  }
}

interface IssueRow {
  id: string;
  occurrence_count: number;
}

/**
 * Waits for a grouped issue whose normalized message contains the fragment.
 * The browser prefixes uncaught window errors ("Uncaught Error: ..."), so a
 * containment match is the stable contract.
 */
async function waitForIssue(
  messageFragment: string,
  minOccurrences: number,
  excludeIssueId?: string,
): Promise<string> {
  return pollUntil(
    async () => {
      const rows = await queryRows<IssueRow>(
        `SELECT id, occurrence_count FROM issues
          WHERE project_id = $1 AND normalized_message LIKE '%' || $2 || '%'
          ORDER BY created_at DESC`,
        [projectId, messageFragment],
      );
      const row = rows.find(
        (candidate) =>
          candidate.occurrence_count >= minOccurrences &&
          candidate.id !== excludeIssueId,
      );
      return row?.id ?? null;
    },
    120_000,
    1_000,
  );
}

interface AnalysisAck {
  id: string;
  issueId: string;
  eventId: string | null;
  status: string;
}

/** Direct API request with an explicit idempotency key. */
async function postAnalysis(
  eventId: string,
  idempotencyKey: string,
  ctx: APIRequestContext = apiCtx,
  cookies: string = ownerCookies,
): Promise<{ status: number; ack: AnalysisAck }> {
  const res = await ctx.post(`/api/v1/events/${eventId}/ai-analyses`, {
    headers: { cookie: cookies, "Idempotency-Key": idempotencyKey },
  });
  const ack = await readJson<AnalysisAck>(res);
  return { status: res.status(), ack };
}

async function fetchAnalysisDetail(
  id: string,
): Promise<Record<string, unknown>> {
  const res = await apiCtx.get(`/api/v1/ai-analyses/${id}`, {
    headers: { cookie: ownerCookies },
  });
  expect(res.ok()).toBeTruthy();
  return readJson<Record<string, unknown>>(res);
}

async function fetchHistory(
  issueId: string,
  limit = 25,
): Promise<Array<{ id: string; status: string }>> {
  const res = await apiCtx.get(
    `/api/v1/issues/${issueId}/ai-analyses?limit=${String(limit)}`,
    { headers: { cookie: ownerCookies } },
  );
  expect(res.ok()).toBeTruthy();
  const body = await readJson<{ items: Array<{ id: string; status: string }> }>(
    res,
  );
  return body.items;
}

/** Waits until one analysis reaches a terminal state, bounded. */
async function waitForTerminal(
  id: string,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  return pollUntil(
    async () => {
      const detail = await fetchAnalysisDetail(id);
      return detail["status"] === "pending" ? null : detail;
    },
    timeoutMs,
    500,
  );
}

interface AnalysisRow {
  error_code: string | null;
  error_message: string | null;
}

async function analysisRow(id: string): Promise<AnalysisRow> {
  const rows = await queryRows<AnalysisRow>(
    `SELECT error_code, error_message FROM ai_analyses WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`analysis row ${id} not found`);
  }
  return row;
}

async function latestEventId(issueId: string): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    `SELECT id FROM events WHERE issue_id = $1
      ORDER BY sequence_number DESC, occurred_at DESC LIMIT 1`,
    [issueId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`issue ${issueId} has no retained occurrence`);
  }
  return row.id;
}

interface ReproductionDetail {
  id: string;
  eventId: string;
  status: string;
  code: string | null;
}

/** Generates a deterministic reproduction through the real worker. */
async function generateReproduction(
  eventId: string,
  timeoutMs = 180_000,
): Promise<ReproductionDetail> {
  const res = await apiCtx.post(`/api/v1/events/${eventId}/reproductions`, {
    headers: {
      cookie: ownerCookies,
      "Idempotency-Key": `e2e-ai-repro-${randomUUID()}`,
    },
  });
  if (!res.ok()) {
    throw new Error(`reproduction request failed: ${res.status()}`);
  }
  const ack = await readJson<{ id: string }>(res);
  return pollUntil(
    async () => {
      const detail = await apiCtx.get(`/api/v1/reproductions/${ack.id}`, {
        headers: { cookie: ownerCookies },
      });
      if (!detail.ok()) return null;
      const body = await readJson<ReproductionDetail>(detail);
      return body.status === "ready" && body.code !== null ? body : null;
    },
    timeoutMs,
    1_000,
  );
}

/**
 * Executes generated code with the repo's Playwright, in a temp dir that
 * carries a `node_modules` junction so the generated
 * `import { test, expect } from '@playwright/test'` resolves without
 * writing anything into the repository. The outer run already owns
 * API :4001, web :3000 and demo :5194, so the nested config starts nothing.
 */
async function runGeneratedSpec(
  code: string,
  label: string,
): Promise<{ passed: boolean; output: string }> {
  const suffix = randomUUID().slice(0, 8);
  const specName = "ai-repro.generated.spec.ts";
  const configName = `ai-tmp-${label}-${suffix}.config.cjs`;
  const workDir = mkdtempSync(join(tmpdir(), `replaybug-ai-e2e-${label}-`));
  const specFile = join(workDir, specName);
  const configFile = join(workDir, configName);
  symlinkSync(
    join(dirname(HERE), "node_modules"),
    join(workDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(specFile, code, "utf8");
  const require = createRequire(import.meta.url);
  const playwrightEntry = require.resolve("@playwright/test");
  const cliEntry = join(
    dirname(require.resolve("@playwright/test/package.json")),
    "cli.js",
  );
  writeFileSync(
    configFile,
    `const { defineConfig } = require(${JSON.stringify(playwrightEntry)});\n` +
      `module.exports = defineConfig({\n` +
      `  testDir: ${JSON.stringify(workDir)},\n` +
      `  testMatch: [${JSON.stringify(specName)}],\n` +
      `  timeout: 60000,\n` +
      `  fullyParallel: false,\n` +
      `  workers: 1,\n` +
      `  reporter: [["line"]],\n` +
      `});\n`,
    "utf8",
  );
  const cleanup = (): void => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup; stray files stay tmp-prefixed for triage.
    }
  };
  return new Promise<{ passed: boolean; output: string }>((resolve) => {
    let output = "";
    const child = spawn(
      process.execPath,
      [cliEntry, "test", "--config", configFile, "--reporter=line"],
      {
        cwd: join(HERE, ".."),
        env: { ...process.env, PLAYWRIGHT_WORKERS: "1" },
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      output += "\n[timeout after 240000ms]";
      cleanup();
      resolve({ passed: false, output });
    }, 240_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        passed: false,
        output: `${output}\nspawn error: ${error.message}`,
      });
    });
    child.on("exit", (exitCode: number | null) => {
      clearTimeout(timer);
      cleanup();
      resolve({ passed: exitCode === 0, output });
    });
  });
}

/** Mock output that references only refs present in the captured evidence. */
function buildMockContent(evidence: MockOllamaEvidenceBundle | null): string {
  if (evidence === null) {
    throw new Error("mock Ollama received a request without evidence");
  }
  const stackRef = evidence.stack[0]?.ref;
  const timelineRef = evidence.timeline[0]?.ref;
  return JSON.stringify({
    summary: MOCK_SUMMARY,
    suspectedCause: MOCK_CAUSE,
    evidence: [
      { ref: "issue:message", reason: "Normalized issue message." },
      ...(stackRef === undefined
        ? []
        : [{ ref: stackRef, reason: "First captured stack frame." }]),
      ...(timelineRef === undefined
        ? []
        : [{ ref: timelineRef, reason: "Closest timeline entry." }]),
    ],
    reproductionSteps: [MOCK_STEP],
    limitations: [MOCK_LIMITATION, MOCK_HOSTILE],
  });
}

/** Opens the notification bell and returns its popover. */
async function openNotifications(page: Page) {
  const bell = page.getByRole("button", { name: /Notifications/ });
  await expect(bell).toBeVisible({ timeout: 15_000 });
  await bell.click();
  const dialog = page.getByRole("dialog", { name: "Notifications" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return dialog;
}

test.beforeAll(async ({ browser }) => {
  await resetE2EDatabase();
  mock = await MockOllamaServer.start({
    mode: "valid",
    model: E2E_OLLAMA_MODEL,
    contentBuilder: (evidence) => buildMockContent(evidence),
  });

  const setupContext = await browser.newContext();
  const setupPage = await setupContext.newPage();
  try {
    ownerEmail = uniqueEmail("ai-owner");
    await registerViaUI(setupPage, ownerEmail, "AI Owner");
    const onboarded = await onboardProjectWithKey(
      setupPage,
      "AI WS",
      "ai-proj",
    );
    projectId = onboarded.projectId;
    publicKey = onboarded.publicKey;
  } finally {
    await setupContext.close();
  }

  const session = await signInAs(ownerEmail);
  apiCtx = session.ctx;
  ownerCookies = session.cookies;
  await configureEnvironmentBaseUrl(apiCtx, ownerCookies, DEMO_URL);
  await addProjectOrigin(apiCtx, ownerCookies, DEMO_ORIGIN);

  worker = await startWorker({ ollamaUrl: mock.url });
  demo = await startDemo(`http://${publicKey}@localhost:4001/api/ingest/v1`);

  demoContext = await browser.newContext();
  const demoPage = await demoContext.newPage();
  await demoPage.goto(DEMO_URL);
  await expect(demoPage.locator("p:has-text('Telemetry:')")).toContainText(
    "Enabled",
    { timeout: 15_000 },
  );
  // A secret fixture typed into the (auto-redacted) password field: it must
  // never reach the outbound AI evidence.
  await demoPage
    .getByPlaceholder("PRIVATE_PASSWORD_E2E_92841")
    .fill(SECRET_FIXTURE);
  // Two navigation-click captures with identical stacks group into one issue
  // with two occurrences, so the occurrence selector is exercisable.
  await demoPage.getByTestId("demo-nav-click-error").click();
  await demoPage.getByTestId("demo-nav-click-error").click();
  navClickIssueId = await waitForIssue(NAV_CLICK_MESSAGE, 2);
});

test.afterAll(async () => {
  await demoContext?.close().catch(() => undefined);
  await demo?.stop().catch(() => undefined);
  await worker?.stop().catch(() => undefined);
  await mock?.stop().catch(() => undefined);
  await apiCtx?.dispose().catch(() => undefined);
});

test("E2E-AI-1 happy path: request → pending → SSE ready, privacy, history, idempotency", async ({
  page,
}) => {
  await loginViaUI(page, ownerEmail);
  await openIssue(page, navClickIssueId);
  await expect(
    page.getByRole("status", { name: /Realtime updates/ }),
  ).toContainText("Live", { timeout: 30_000 });

  const panel = page.locator("#ai-analysis");
  await expect(panel.getByText(E2E_OLLAMA_MODEL)).toBeVisible({
    timeout: 15_000,
  });

  // Select the older occurrence explicitly: the request must target it.
  const selector = page.getByLabel("Occurrence", { exact: true });
  await expect(selector).toBeVisible({ timeout: 15_000 });
  const options = await selector.locator("option").all();
  expect(options.length).toBeGreaterThanOrEqual(2);
  const chosen =
    (await options[options.length - 1]?.getAttribute("value")) ?? "";
  expect(chosen).not.toBe("");
  selectedEventId = chosen;
  await selector.selectOption(selectedEventId);

  // An internal issue comment exists alongside the analysis: comments are a
  // product feature, but they are never part of the outbound evidence.
  const commentResponse = await apiCtx.post(
    `/api/v1/issues/${navClickIssueId}/comments`,
    {
      headers: { cookie: ownerCookies },
      data: { body: `${COMMENT_MARKER} internal note, never evidence.` },
    },
  );
  expect(commentResponse.ok()).toBeTruthy();

  // A reload would destroy this sentinel; the panel update must come from SSE.
  await page.evaluate(() => {
    (window as unknown as { __aiNoReload?: string }).__aiNoReload = "alive";
  });

  mock.setMode("delayed", { delayMs: 2_500 });
  mock.clearRequests();
  const analyze = panel.getByRole("button", { name: "Analyze with local AI" });
  await expect(analyze).toBeVisible({ timeout: 15_000 });
  const [analysisRequest] = await Promise.all([
    page.waitForRequest(
      (req) => req.method() === "POST" && req.url().includes("/ai-analyses"),
      { timeout: 30_000 },
    ),
    analyze.click(),
  ]);
  const idempotencyKey = analysisRequest.headers()["idempotency-key"] ?? "";
  expect(idempotencyKey).not.toBe("");
  const analysisResponse = await analysisRequest.response();
  if (analysisResponse === null) {
    throw new Error("AI analysis request produced no response");
  }
  expect(analysisResponse.status()).toBe(202);
  const ack = await readJson<AnalysisAck>(analysisResponse);
  expect(ack.eventId).toBe(selectedEventId);
  expect(ack.status).toBe("pending");
  readyAnalysisId = ack.id;

  // Pending copy is visible while the model call is still in flight.
  await expect(
    panel.getByText("Analyzing with local Ollama…").first(),
  ).toBeVisible({ timeout: 15_000 });

  // Exactly one provider request for one analysis.
  await expect
    .poll(() => mock.requestCount, { timeout: 20_000, intervals: [250] })
    .toBe(1);
  const providerRequest = mock.requests[0];
  if (providerRequest === undefined) {
    throw new Error("mock Ollama captured no request");
  }
  // Outbound protocol conformance (real Ollama /api/chat contract).
  expect(providerRequest.method).toBe("POST");
  expect(providerRequest.path).toBe("/api/chat");
  expect(providerRequest.contentType).toContain("application/json");
  const chatBody = asChatBody(providerRequest.body);
  if (chatBody === null) {
    throw new Error("captured provider body is not an /api/chat body");
  }
  expect(chatBody.model).toBe(E2E_OLLAMA_MODEL);
  expect(chatBody.stream).toBe(false);
  expect(chatBody.options?.["temperature"]).toBe(0);
  expect(chatBody.format).toMatchObject({ type: "object" });
  expect(Object.hasOwn(chatBody, "tools")).toBe(false);
  expect(chatBody.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
  ]);

  // Outbound evidence whitelist: exact keys, normalized error, first stack
  // frame, relevant timeline entry, environment and release.
  const bundle = extractEvidenceBundle(chatBody);
  if (bundle === null) {
    throw new Error("captured provider body carries no evidence bundle");
  }
  expect(Object.keys(bundle).sort()).toEqual([
    "environment",
    "issue",
    "network",
    "release",
    "stack",
    "timeline",
    "timestamps",
  ]);
  expect(Object.keys(bundle.issue).sort()).toEqual([
    "exceptionType",
    "message",
    "severity",
    "type",
  ]);
  expect(bundle.issue.message.text).toBe(NAV_CLICK_MESSAGE);
  expect(bundle.issue.type).toBe("exception");
  expect(bundle.issue.severity).toBe("error");
  expect(bundle.environment).toBe("production");
  expect(bundle.release?.value).toBe("demo-ai-e2e@0.1.0");
  expect(bundle.stack.length).toBeGreaterThan(0);
  expect(bundle.stack[0]?.ref).toBe("stack:1");
  expect(bundle.stack[0]?.source).not.toBe("");
  expect(bundle.stack[0]?.line).toBeGreaterThan(0);
  expect(bundle.timeline.length).toBeGreaterThan(0);
  expect(bundle.timeline[0]?.ref).toBe(`timeline:${selectedEventId}`);

  // Privacy exclusions on the exact outbound bytes and headers.
  const outbound = providerRequest.rawBody;
  const sessionRows = await queryRows<{ telemetry_session_id: string }>(
    `SELECT telemetry_session_id FROM events WHERE issue_id = $1 LIMIT 1`,
    [navClickIssueId],
  );
  const sessionId = sessionRows[0]?.telemetry_session_id ?? "";
  expect(sessionId).not.toBe("");
  const forbidden: Array<[string, string]> = [
    ["seed password", E2E_PASSWORD],
    ["typed secret fixture", SECRET_FIXTURE],
    ["public ingest key", publicKey],
    ["comment marker", COMMENT_MARKER],
    ["jwt fixture", DEMO_JWT_FIXTURE],
    ["authorization header", "authorization"],
    ["cookie header", "cookie"],
    ["set-cookie", "set-cookie"],
    ["bearer token", "Bearer "],
    ["source map content", "sourcesContent"],
    ["source map url", "sourceMappingURL"],
    ["raw payload session id", sessionId],
    ["reproduction code import", "import { test, expect }"],
    ["reproduction pageerror hook", "page.on('pageerror'"],
    ["markdown renderer", "dangerouslySetInnerHTML"],
    ["provider sentinel", PROVIDER_SENTINEL],
  ];
  for (const [label, value] of forbidden) {
    expect(outbound, `outbound evidence leaked ${label}`).not.toContain(value);
  }
  const headerNames = Object.keys(providerRequest.headers).map((name) =>
    name.toLowerCase(),
  );
  expect(headerNames).not.toContain("cookie");
  expect(headerNames).not.toContain("authorization");
  expect(headerNames).not.toContain("x-api-key");

  // Ready lands through targeted SSE invalidation, without a reload.
  await expect(panel.getByText(DISCLAIMER)).toBeVisible({ timeout: 90_000 });
  expect(providerRequest.status).toBe(200);
  const sentinel = await page.evaluate(
    () => (window as unknown as { __aiNoReload?: string }).__aiNoReload ?? null,
  );
  expect(sentinel).toBe("alive");
  await expect(panel.getByText("Analyzing with local Ollama…")).toHaveCount(0);
  await expect(panel.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText(MOCK_SUMMARY)).toBeVisible();
  await expect(panel.getByText(MOCK_CAUSE)).toBeVisible();
  await expect(panel.getByText(MOCK_STEP)).toBeVisible();
  await expect(panel.getByText(MOCK_LIMITATION)).toBeVisible();
  // Model text renders inertly: the hostile string is visible as text and
  // never executed as markup.
  await expect(panel.getByText(MOCK_HOSTILE)).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __aiXss?: boolean }).__aiXss ?? null,
    ),
  ).toBeNull();
  await expect(panel.getByText("History (1)")).toBeVisible();

  // Evidence links resolve to the exact frame and the exact timeline entry.
  const frameAnchor = page.locator('[data-stack-frame-index="1"]');
  await expect(frameAnchor).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: "Highlight frame 1" }).click();
  await expect(frameAnchor).toHaveAttribute("data-ai-highlight", "true", {
    timeout: 5_000,
  });
  const timelineLink = panel.getByRole("link", { name: "View timeline event" });
  await expect(timelineLink).toHaveAttribute(
    "href",
    new RegExp(`event=${selectedEventId}$`),
  );
  await timelineLink.click();
  await expect(page).toHaveURL(new RegExp(`event=${selectedEventId}`));
  await expect(
    page.locator(
      `[data-timeline-event-id="${selectedEventId}"][data-ai-highlight="true"]`,
    ),
  ).toBeVisible({ timeout: 5_000 });

  // Requester notification is visible in the bell.
  const dialog = await openNotifications(page);
  await expect(dialog.getByText("AI analysis ready")).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press("Escape");

  // The outbox row for this analysis is dispatched (durable async path).
  const outboxRows = await queryRows<{ dispatched_at: string | null }>(
    `SELECT dispatched_at FROM ai_analysis_outbox WHERE analysis_id = $1`,
    [readyAnalysisId],
  );
  expect(outboxRows[0]?.dispatched_at).not.toBeNull();

  // Immutability baseline for the "analyze again" comparison.
  firstReadySnapshot = await fetchAnalysisDetail(readyAnalysisId);
  expect(firstReadySnapshot["status"]).toBe("ready");

  // Idempotent replay: the same key twice never forks history and never
  // triggers another model call for the already-terminal analysis.
  mock.clearRequests();
  const replayOne = await postAnalysis(selectedEventId, idempotencyKey);
  const replayTwo = await postAnalysis(selectedEventId, idempotencyKey);
  expect(replayOne.status).toBe(200);
  expect(replayTwo.status).toBe(200);
  expect(replayOne.ack.id).toBe(readyAnalysisId);
  expect(replayTwo.ack.id).toBe(readyAnalysisId);
  expect(await fetchHistory(navClickIssueId)).toHaveLength(1);
  expect(mock.requestCount).toBe(0);

  // Analyze again: a second immutable row; the first stays byte-identical.
  mock.setMode("valid");
  const again = panel.getByRole("button", { name: "Analyze again" });
  await expect(again).toBeVisible({ timeout: 15_000 });
  await again.click();
  await expect
    .poll(async () => (await fetchHistory(navClickIssueId)).length, {
      timeout: 90_000,
      intervals: [1_000],
    })
    .toBe(2);
  // The API commits the second analysis row before the worker reaches the
  // provider. Wait for the observable provider request instead of racing that
  // asynchronous boundary with an immediate counter assertion.
  await pollUntil(async () =>
    mock.requestCount === 1 ? mock.requestCount : null,
  );
  expect(mock.requestCount).toBe(1);
  const firstAfterSecond = await fetchAnalysisDetail(readyAnalysisId);
  expect(firstAfterSecond).toEqual(firstReadySnapshot);
  await expect(panel.getByText("History (2)")).toBeVisible({
    timeout: 30_000,
  });

  // A reproduction exists for this issue, yet the AI evidence never carried
  // its code: the reproduction path stays outside the AI boundary.
  const reproduction = await generateReproduction(selectedEventId);
  expect(reproduction.code).not.toBeNull();
  expect(reproduction.code ?? "").toContain("page.on('pageerror'");
  expect(outbound).not.toContain("import { test, expect }");
  expect(outbound).not.toContain("// ReplayBug reproduction");
  expect(outbound).not.toContain(reproduction.code ?? "unreachable");
});

test("E2E-AI-2 viewer: reads history, no request controls, direct POST is 403", async ({
  page,
}) => {
  const viewerEmail = uniqueEmail("ai-viewer");
  const viewerCtx = await request.newContext({ baseURL: API });
  try {
    const signup = await viewerCtx.post("/api/auth/sign-up/email", {
      data: { email: viewerEmail, password: E2E_PASSWORD, name: "AI Viewer" },
    });
    expect(signup.ok()).toBeTruthy();
  } finally {
    await viewerCtx.dispose();
  }
  const userRows = await queryRows<{ id: string }>(
    `SELECT id FROM "user" WHERE email = $1`,
    [viewerEmail],
  );
  const viewerId = userRows[0]?.id ?? "";
  expect(viewerId).not.toBe("");
  const projectRows = await queryRows<{ workspace_id: string }>(
    `SELECT workspace_id FROM projects WHERE id = $1`,
    [projectId],
  );
  const workspaceId = projectRows[0]?.workspace_id ?? "";
  expect(workspaceId).not.toBe("");
  await queryRows(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
    [workspaceId, viewerId],
  );

  await loginViaUI(page, viewerEmail);
  await openIssue(page, navClickIssueId);
  const panel = page.locator("#ai-analysis");
  await expect(panel.getByText(DISCLAIMER)).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(MOCK_SUMMARY)).toBeVisible();
  await expect(panel.getByText(/cannot request new analyses/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /Analyze/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^Retry/ })).toHaveCount(0);

  const viewerSession = await signInAs(viewerEmail);
  try {
    const denied = await postAnalysis(
      selectedEventId,
      `e2e-ai-viewer-denied-${randomUUID()}`,
      viewerSession.ctx,
      viewerSession.cookies,
    );
    expect(denied.status).toBe(403);
  } finally {
    await viewerSession.ctx.dispose();
  }
  // The denied request created no row for the viewer.
  const viewerRows = await queryRows<{ count: string }>(
    `SELECT count(*)::text AS count FROM ai_analyses WHERE requested_by_user_id = $1`,
    [viewerId],
  );
  expect(viewerRows[0]?.count).toBe("0");
});

test("E2E-AI-3 degraded provider: timeout, invalid output and refs, 500, 429 stay bounded", async ({
  page,
}) => {
  await restartWorker({
    ollamaUrl: mock.url,
    timeoutMs: 1_000,
    retryLimit: 0,
  });
  const eventId = selectedEventId;

  // Timeout: the mock outlives the configured provider timeout.
  mock.setMode("delayed", { delayMs: 4_000 });
  mock.clearRequests();
  const timeoutStartedAt = Date.now();
  const timeoutAck = await postAnalysis(
    eventId,
    `e2e-ai-timeout-${randomUUID()}`,
  );
  expect(timeoutAck.status).toBe(202);
  const timeoutDetail = await waitForTerminal(timeoutAck.ack.id);
  expect(timeoutDetail["status"]).toBe("failed");
  expect(timeoutDetail["errorCode"]).toBe("AI_ANALYSIS_TIMEOUT");
  expect(Date.now() - timeoutStartedAt).toBeLessThan(60_000);
  const timeoutRow = await analysisRow(timeoutAck.ack.id);
  expect(timeoutRow.error_code).toBe("AI_ANALYSIS_TIMEOUT");
  expect(timeoutRow.error_message).toBe("Model request timed out.");

  // UI pass 1: the newest analysis is the bounded timeout, with safe copy.
  await loginViaUI(page, ownerEmail);
  await openIssue(page, navClickIssueId);
  const panel = page.locator("#ai-analysis");
  await expect(panel.getByText("The local model timed out")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    panel.getByText("Ollama did not respond in time. You can try again."),
  ).toBeVisible();
  await expect(page.getByText(PROVIDER_SENTINEL)).toHaveCount(0);

  // The worker is not hung: another job (valid mode) still completes.
  mock.setMode("valid");
  const healthyAck = await postAnalysis(
    eventId,
    `e2e-ai-healthy-${randomUUID()}`,
  );
  const healthyDetail = await waitForTerminal(healthyAck.ack.id);
  expect(healthyDetail["status"]).toBe("ready");

  // Malformed JSON content: one deterministic structured retry, then a safe
  // failure that never surfaces the raw provider text.
  mock.setMode("malformed-json");
  mock.clearRequests();
  const malformedAck = await postAnalysis(
    eventId,
    `e2e-ai-malformed-${randomUUID()}`,
  );
  const malformedDetail = await waitForTerminal(malformedAck.ack.id);
  expect(malformedDetail["status"]).toBe("failed");
  expect(malformedDetail["errorCode"]).toBe("AI_ANALYSIS_RESPONSE_INVALID");
  expect(mock.requestsInMode("malformed-json")).toHaveLength(2);
  const malformedRow = await analysisRow(malformedAck.ack.id);
  expect(malformedRow.error_code).toBe("AI_ANALYSIS_RESPONSE_INVALID");
  expect(malformedRow.error_message).toBe(
    "Model did not return valid structured output.",
  );
  expect(malformedRow.error_message).not.toContain(PROVIDER_SENTINEL);
  expect(MALFORMED_CONTENT).toContain(PROVIDER_SENTINEL);

  // Wrong-schema JSON: it parses, but violates the strict structured
  // contract, so it fails exactly like malformed content and never leaks.
  mock.setMode("wrong-schema");
  mock.clearRequests();
  const wrongSchemaAck = await postAnalysis(
    eventId,
    `e2e-ai-wrong-schema-${randomUUID()}`,
  );
  const wrongSchemaDetail = await waitForTerminal(wrongSchemaAck.ack.id);
  expect(wrongSchemaDetail["status"]).toBe("failed");
  expect(wrongSchemaDetail["errorCode"]).toBe("AI_ANALYSIS_RESPONSE_INVALID");
  expect(mock.requestsInMode("wrong-schema")).toHaveLength(2);
  const wrongSchemaRow = await analysisRow(wrongSchemaAck.ack.id);
  expect(wrongSchemaRow.error_message).not.toContain(PROVIDER_SENTINEL);
  expect(WRONG_SCHEMA_CONTENT).toContain(PROVIDER_SENTINEL);

  // Unknown evidence refs: schema-valid but referencing evidence that was
  // never offered.
  mock.setMode("unknown-ref");
  mock.clearRequests();
  const refAck = await postAnalysis(eventId, `e2e-ai-ref-${randomUUID()}`);
  const refDetail = await waitForTerminal(refAck.ack.id);
  expect(refDetail["status"]).toBe("failed");
  expect(refDetail["errorCode"]).toBe("AI_ANALYSIS_RESPONSE_INVALID");
  expect(mock.requestsInMode("unknown-ref")).toHaveLength(2);

  // UI pass 2: the newest analysis is the unknown-ref failure. Invalid model
  // output never renders raw provider text or unresolvable refs.
  await openIssue(page, navClickIssueId);
  await expect(panel.getByText("Invalid model response")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    panel.getByText(
      "The local model returned an invalid structured response. You can try again.",
    ),
  ).toBeVisible();
  await expect(page.getByText(PROVIDER_SENTINEL)).toHaveCount(0);
  await expect(page.getByText("stack:999")).toHaveCount(0);
  await expect(page.getByText("evidence:not-a-real-ref")).toHaveCount(0);

  // HTTP failures are transient for the provider, terminal for the row with
  // zero retries left.
  mock.setMode("http-500");
  const serverErrorAck = await postAnalysis(
    eventId,
    `e2e-ai-500-${randomUUID()}`,
  );
  const serverErrorDetail = await waitForTerminal(serverErrorAck.ack.id);
  expect(serverErrorDetail["status"]).toBe("failed");
  expect(serverErrorDetail["errorCode"]).toBe(
    "AI_ANALYSIS_PROVIDER_UNAVAILABLE",
  );

  mock.setMode("http-429");
  const busyAck = await postAnalysis(eventId, `e2e-ai-429-${randomUUID()}`);
  const busyDetail = await waitForTerminal(busyAck.ack.id);
  expect(busyDetail["status"]).toBe("failed");
  expect(busyDetail["errorCode"]).toBe("AI_ANALYSIS_PROVIDER_UNAVAILABLE");

  // Abrupt connection close: the request is captured, the socket dies before
  // a response, and the analysis still fails safely — with the same privacy
  // exclusions on the bytes that did leave the process.
  mock.setMode("connection-close");
  mock.clearRequests();
  const closedAck = await postAnalysis(
    eventId,
    `e2e-ai-closed-${randomUUID()}`,
  );
  const closedDetail = await waitForTerminal(closedAck.ack.id);
  expect(closedDetail["status"]).toBe("failed");
  expect(closedDetail["errorCode"]).toBe("AI_ANALYSIS_PROVIDER_UNAVAILABLE");
  const closedRequest = mock.requestsInMode("connection-close")[0];
  if (closedRequest === undefined) {
    throw new Error("connection-close mode captured no request");
  }
  expect(closedRequest.status).toBeNull();
  expect(closedRequest.rawBody).not.toContain(E2E_PASSWORD);
  expect(closedRequest.rawBody).not.toContain(publicKey);
  expect(closedRequest.rawBody).not.toContain(SECRET_FIXTURE);
});

test("E2E-AI-4 provider down: safe failure + notification, core ingest and reproduction still PASS", async ({
  browser,
}) => {
  await restartWorker({
    ollamaUrl: await closedPortUrl(),
    timeoutMs: 1_000,
    retryLimit: 0,
  });

  const outageAck = await postAnalysis(
    selectedEventId,
    `e2e-ai-down-${randomUUID()}`,
  );
  expect(outageAck.status).toBe(202);
  const outageDetail = await waitForTerminal(outageAck.ack.id);
  expect(outageDetail["status"]).toBe("failed");
  expect(outageDetail["errorCode"]).toBe("AI_ANALYSIS_PROVIDER_UNAVAILABLE");
  const outageRow = await analysisRow(outageAck.ack.id);
  expect(outageRow.error_message).toBe("Model connection failed.");

  // During the outage a brand-new demo error still creates a new issue. A
  // fresh session keeps the generated reproduction plan minimal (one
  // navigation), which is the shape proven by e2e/reproduction.spec.ts.
  const outageContext = await browser.newContext();
  try {
    const outagePage = await outageContext.newPage();
    await outagePage.goto(DEMO_URL);
    await expect(outagePage.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
      { timeout: 15_000 },
    );
    await outagePage.getByTestId("demo-uncaught-error").click();
    await expect(outagePage.getByText(/Uncaught error armed/)).toBeVisible({
      timeout: 15_000,
    });
    outageIssueId = await waitForIssue(UNCAUGHT_MESSAGE, 1, navClickIssueId);
    expect(outageIssueId).not.toBe(navClickIssueId);
    const outageEventId = await latestEventId(outageIssueId);

    // Deterministic Playwright reproduction still generates and passes.
    const reproduction = await generateReproduction(outageEventId);
    const code = reproduction.code ?? "";
    expect(code).toContain("page.on('pageerror'");
    expect(code).toContain("demo-uncaught-error");
    const result = await runGeneratedSpec(code, "outage");
    expect(result.output).toContain("passed");
    expect(result.passed).toBe(true);
  } finally {
    await outageContext.close().catch(() => undefined);
  }
});

test("E2E-AI-4b provider down: failed analysis renders safe copy and notifies the requester", async ({
  page,
}) => {
  await loginViaUI(page, ownerEmail);
  await openIssue(page, navClickIssueId);
  const panel = page.locator("#ai-analysis");
  await expect(panel.getByText("Ollama unavailable")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    panel.getByText("The local model was unavailable. You can try again."),
  ).toBeVisible();
  const dialog = await openNotifications(page);
  await expect(
    dialog.getByText("AI analysis failed: provider unavailable").first(),
  ).toBeVisible({ timeout: 15_000 });
});

test("E2E-AI-5 disabled stack: capability reports disabled, POST is AI_NOT_CONFIGURED", async ({
  page,
}) => {
  const disabledApi = await startApiWithoutOllama();
  try {
    const disabledCtx = await request.newContext({ baseURL: disabledApi.url });
    let disabledCapability: {
      aiAnalysis: { configured: boolean; status: string };
    };
    try {
      const capability = await disabledCtx.get("/api/v1/meta/ai-analysis", {
        headers: { cookie: ownerCookies },
      });
      expect(capability.status()).toBe(200);
      disabledCapability = await readJson<{
        aiAnalysis: { configured: boolean; status: string };
      }>(capability);
      expect(disabledCapability).toMatchObject({
        aiAnalysis: { configured: false, status: "disabled" },
      });

      const outageIssueRows = await queryRows<{ id: string }>(
        `SELECT id FROM issues WHERE id = $1`,
        [outageIssueId],
      );
      if (outageIssueRows[0]?.id !== outageIssueId) {
        throw new Error("the outage issue created in E2E-AI-4 is missing");
      }
      const disabledEventId = await latestEventId(outageIssueId);
      const denied = await disabledCtx.post(
        `/api/v1/events/${disabledEventId}/ai-analyses`,
        {
          headers: {
            cookie: ownerCookies,
            "Idempotency-Key": `e2e-ai-disabled-${randomUUID()}`,
          },
        },
      );
      expect(denied.status()).toBe(503);
      expect(await readJson<unknown>(denied)).toMatchObject({
        code: "AI_NOT_CONFIGURED",
      });
      const orphanRows = await queryRows<{ count: string }>(
        `SELECT count(*)::text AS count FROM ai_analyses WHERE event_id = $1`,
        [disabledEventId],
      );
      expect(orphanRows[0]?.count).toBe("0");
    } finally {
      await disabledCtx.dispose();
    }

    // UI disabled state: the capability response the real AI-disabled API
    // instance just returned is served to the panel, so the disabled
    // rendering path is exercised with a genuine disabled payload.
    await page.route("**/api/v1/meta/ai-analysis", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(disabledCapability),
      });
    });
    await loginViaUI(page, ownerEmail);
    // The outage issue has no analysis history, so the panel cannot render
    // the analysis-detail retry affordance: only the capability gate is in
    // play.
    await openIssue(page, outageIssueId);
    const panel = page.locator("#ai-analysis");
    await expect(
      panel.getByText("Local AI analysis is not configured."),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByText("Core ReplayBug functionality does not require AI."),
    ).toBeVisible();
    await expect(panel.getByText("No AI analyses yet.")).toBeVisible();
    await expect(panel.getByRole("button", { name: /Analyze/ })).toHaveCount(0);
    // The core product is unaffected: evidence and reproduction controls stay.
    await expect(page.getByText(/Occurrence evidence/)).toBeVisible();
  } finally {
    await disabledApi.stop().catch(() => undefined);
  }
});
