import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { Pool } from "pg";
import * as ts from "typescript";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * E2E-REPRO full Playwright-reproduction flow on the real stack
 * (real PG + real API + real worker + real web + real demo + real Chromium).
 *
 * Flow: register → project (UI) → production env base URL → local demo
 * origin + ingest DSN → drive Chromium through the demo uncaught-error
 * scenario (Navigation → Click → real pageerror)
 * → worker builds the issue → issue detail → Generate → poll to ready →
 * semantic locator + pageerror assertions → clipboard copy → download equals
 * stored code → syntax validate → execute against local demo (PASS) →
 * negative control without the failure (FAIL) → regenerate (2 history rows)
 * → viewer can inspect but not generate.
 *
 * All targets are loopback-only. Bounded waits throughout, no skips.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const API = "http://localhost:4001";
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
const DEMO_PORT = 5193;
const DEMO_URL = `http://localhost:${DEMO_PORT}`;
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`;
const WORKER_ENTRY = join(ROOT, "apps", "worker", "dist", "index.js");

test.setTimeout(600_000);
// Tracing is off for this file: it spawns nested Playwright runs inside
// the test, and on Windows the outer trace finalization races with the
// nested browser (ENOENT on .network trace files), masking real results
// as teardown failures. CI/Linux is unaffected.
test.use({ trace: "off" });

function db(): Pool {
  return new Pool({ connectionString: DB_URL });
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

function cookiesFromHeaders(
  headers: Array<{ name: string; value: string }>,
): string {
  return headers
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0] ?? "")
    .filter((part) => part !== "")
    .join("; ");
}

async function ownerApiContext(email: string): Promise<{
  ctx: APIRequestContext;
  cookies: string;
}> {
  const ctx = await request.newContext({ baseURL: API });
  const signin = await ctx.post("/api/auth/sign-in/email", {
    data: { email, password: E2E_PASSWORD },
  });
  if (!signin.ok()) {
    throw new Error(`owner sign-in failed: ${signin.status()}`);
  }
  const cookies = cookiesFromHeaders(await signin.headersArray());
  return { ctx, cookies };
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
  projectId: string,
  baseUrl: string,
): Promise<void> {
  const listRes = await ctx.get(`/api/v1/projects/${projectId}/environments`, {
    headers: { cookie: cookies },
  });
  if (!listRes.ok()) {
    throw new Error(`list environments failed: ${listRes.status()}`);
  }
  const items = (await listRes.json()) as EnvironmentItem[];
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
  projectId: string,
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
  // No shell: spawn executables directly so the suite works on Windows
  // (shell:true resolves cmd.exe, which is unavailable in some CI/dev
  // environments) and avoids shell-quoting hazards everywhere else.
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

async function startWorker(): Promise<SpawnedProcess> {
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

async function startDemo(dsn: string): Promise<SpawnedProcess> {
  // Launch Vite directly with node (no pnpm shell shim, so Windows works).
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
        VITE_REPLAYBUG_RELEASE: "demo-e2e@0.1.0",
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

interface IssueRow {
  id: string;
  title: string;
}

async function waitForNavClickIssue(projectId: string): Promise<IssueRow> {
  const pool = db();
  try {
    return await pollUntil(
      async () => {
        const res = await pool.query(
          `SELECT id, title FROM issues
           WHERE project_id = $1 AND title LIKE '%after navigation and click%'
           ORDER BY created_at DESC LIMIT 1`,
          [projectId],
        );
        const row = res.rows[0] as IssueRow | undefined;
        return row ?? null;
      },
      120_000,
      1_000,
    );
  } finally {
    await pool.end();
  }
}

interface ReproductionSummary {
  id: string;
  eventId: string;
  status: "pending" | "ready" | "failed";
}

interface ReproductionList {
  items: ReproductionSummary[];
}

interface ReproductionDetail extends ReproductionSummary {
  issueId: string;
  language: string;
  framework: string;
  code: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

async function waitForReproductionReady(
  ctx: APIRequestContext,
  cookies: string,
  reproductionId: string,
): Promise<ReproductionDetail> {
  return pollUntil(
    async () => {
      const res = await ctx.get(`/api/v1/reproductions/${reproductionId}`, {
        headers: { cookie: cookies },
      });
      if (!res.ok()) {
        return null;
      }
      const detail = (await res.json()) as ReproductionDetail;
      return detail.status === "ready" ? detail : null;
    },
    180_000,
    1_000,
  );
}

async function waitForHistoryCount(
  ctx: APIRequestContext,
  cookies: string,
  issueId: string,
  count: number,
): Promise<ReproductionSummary[]> {
  return pollUntil(
    async () => {
      const res = await ctx.get(
        `/api/v1/issues/${issueId}/reproductions?limit=25`,
        { headers: { cookie: cookies } },
      );
      if (!res.ok()) {
        return null;
      }
      const list = (await res.json()) as ReproductionList;
      if (list.items.length < count) {
        return null;
      }
      if (list.items.every((item) => item.status === "ready")) {
        return list.items;
      }
      return null;
    },
    180_000,
    1_000,
  );
}

function syntaxOk(code: string): boolean {
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).length === 0;
}

/**
 * Executes generated code with the repo's Playwright Chromium (nested run).
 * The generated code is written to a TEMP dir; a minimal no-servers config
 * next to this suite points testDir at that TEMP dir (the outer run already
 * owns API :4001 + web :3000 + demo :5193, so the nested config starts
 * nothing). Temp files are removed afterwards.
 */
async function runGeneratedSpec(
  code: string,
  label: string,
): Promise<{ passed: boolean; output: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const specName = `repro.generated.spec.ts`;
  const configName = `repro-tmp-${label}-${suffix}.config.ts`;
  const e2eDir = dirname(new URL(import.meta.url).pathname).replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  const packageDir = dirname(e2eDir);
  const workDir = mkdtempSync(join(tmpdir(), `replaybug-e2e-${label}-`));
  const specFile = join(workDir, specName);
  const configFile = join(e2eDir, configName);
  writeFileSync(specFile, code, "utf8");
  writeFileSync(
    configFile,
    `import { defineConfig } from "@playwright/test";\n` +
      `export default defineConfig({\n` +
      `  testDir: ${JSON.stringify(workDir)},\n` +
      `  testMatch: [${JSON.stringify(specName)}],\n` +
      `  timeout: 60000,\n` +
      `  fullyParallel: false,\n` +
      `  workers: 1,\n` +
      `  reporter: [["line"]],\n` +
      `});\n`,
    "utf8",
  );
  // Resolve the CLI through the package.json subpath (always exported) to
  // avoid the exports-map block on ./cli.js and any shell quoting issues.
  const require = createRequire(import.meta.url);
  const cliEntry = join(
    dirname(require.resolve("@playwright/test/package.json")),
    "cli.js",
  );
  const cleanup = (): void => {
    try {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(configFile, { force: true });
    } catch {
      // Best-effort temp cleanup; stray files are tmp-prefixed for triage.
    }
  };
  return new Promise<{ passed: boolean; output: string }>((resolvePromise) => {
    let output = "";
    const child = spawn(
      process.execPath,
      [cliEntry, "test", "--config", configFile, "--reporter=line"],
      { cwd: packageDir, env: { ...process.env, PLAYWRIGHT_WORKERS: "1" } },
    );
    const timer = setTimeout(() => {
      child.kill();
      output += "\n[timeout after 240000ms]";
      cleanup();
      resolvePromise({ passed: false, output });
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
      resolvePromise({
        passed: false,
        output: `${output}\nspawn error: ${error.message}`,
      });
    });
    child.on("exit", (exitCode: number | null) => {
      clearTimeout(timer);
      cleanup();
      resolvePromise({ passed: exitCode === 0, output });
    });
  });
}

/** Stub demo without the failure: same button, no error on click. */
async function startFailureFreeStub(): Promise<{
  server: Server;
  origin: string;
  stop: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    void req;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>stub</title></head><body>` +
        `<button data-testid="demo-uncaught-error">7. Uncaught Error (pageerror)</button>` +
        `</body></html>`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub server has no port");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    server,
    origin,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

test("E2E-REPRO failure → generation → verify → negative control → regenerate → viewer", async ({
  page,
  browser,
}) => {
  await resetE2EDatabase();
  const pool = db();
  try {
    await pool.query(
      `TRUNCATE reproduction_generation_outbox, reproduction_tests RESTART IDENTITY CASCADE`,
    );
  } finally {
    await pool.end();
  }

  const ownerEmail = uniqueEmail("repro-owner");
  const viewerEmail = uniqueEmail("repro-viewer");
  await registerViaUI(page, ownerEmail, "Repro Owner");
  const { projectId, publicKey } = await onboardProjectWithKey(
    page,
    "Repro WS",
    "repro-proj",
  );

  const { ctx: apiCtx, cookies } = await ownerApiContext(ownerEmail);
  let worker: SpawnedProcess | null = null;
  let demo: SpawnedProcess | null = null;
  let demoContext: BrowserContext | null = null;
  try {
    await configureEnvironmentBaseUrl(apiCtx, cookies, projectId, DEMO_URL);
    await addProjectOrigin(apiCtx, cookies, projectId, DEMO_ORIGIN);

    worker = await startWorker();
    const dsnWithKey = `http://${publicKey}@localhost:4001/api/ingest/v1`;
    demo = await startDemo(dsnWithKey);

    // Drive Chromium through the demo uncaught-error scenario
    // (Navigation → Click → real pageerror, assertable by the repro).
    demoContext = await browser.newContext();
    const demoPage = await demoContext.newPage();
    await demoPage.goto(DEMO_URL);
    await expect(demoPage.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
      { timeout: 15_000 },
    );
    await demoPage.getByTestId("demo-uncaught-error").click();
    await expect(demoPage.getByText(/Uncaught error armed/)).toBeVisible({
      timeout: 15_000,
    });

    // Worker builds the issue from real telemetry.
    const issue = await waitForNavClickIssue(projectId);

    // Open issue detail; SSE stream is live (fallback: REST polling below).
    await page.goto(`/app/projects/${projectId}/issues/${issue.id}`);
    await expect(
      page.getByRole("heading", { name: /after navigation and click/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Occurrence evidence/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("status", { name: /Realtime updates/ }),
    ).toContainText("Live", { timeout: 30_000 });

    // Occurrence is selected (single occurrence: default selection).
    await expect(
      page.getByText(/Raw stack trace|evidence/).first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    // Generate from the selected occurrence.
    const generateButton = page.getByRole("button", {
      name: "Generate reproduction",
    });
    await expect(generateButton).toBeVisible({ timeout: 15_000 });
    const [generateResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes("/api/v1/events/") &&
          res.url().includes("/reproductions") &&
          res.request().method() === "POST",
        { timeout: 30_000 },
      ),
      generateButton.click(),
    ]);
    if (!generateResponse.ok()) {
      throw new Error(`generate request failed: ${generateResponse.status()}`);
    }
    const ack = (await generateResponse.json()) as { id: string };
    console.log("[stage] generated ack");
    expect(ack.id).not.toBe("");

    // Await ready (SSE invalidates the panel; REST poll is the fallback).
    const detail = await waitForReproductionReady(apiCtx, cookies, ack.id);
    console.log("[stage] ready");
    await expect(page.getByText("Ready").first()).toBeVisible({
      timeout: 60_000,
    });
    const code = detail.code ?? "";
    expect(code).not.toBe("");
    // Ready code carries a semantic locator and the pageerror assertion.
    const hasSemanticLocator =
      code.includes("getByTestId('demo-uncaught-error')") ||
      (code.includes("getByRole") && code.includes("demo-uncaught-error")) ||
      (code.includes("getByRole") && code.includes("Uncaught Error"));
    expect(hasSemanticLocator).toBe(true);
    expect(code).toContain("page.on('pageerror'");
    // Copy: clipboard holds exactly the stored code.
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .getByRole("button", { name: "Copy", exact: true })
      .click({ timeout: 30_000 });
    await expect(page.getByText("Copied to clipboard.")).toBeVisible({
      timeout: 15_000,
    });
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Windows clipboard normalizes LF to CRLF; the stored code stays LF
    // (download asserts exact bytes below). Compare normalized.
    expect(clipboard.replace(/\r\n/g, "\n")).toBe(code);
    console.log("[stage] copied");

    // Download: bytes equal the stored code.
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page
        .getByRole("button", { name: "Download", exact: true })
        .click({ timeout: 30_000 }),
    ]);
    const downloadPath = await download.path();
    if (downloadPath === null) {
      throw new Error("download has no path");
    }
    const downloaded = readFileSync(downloadPath, "utf8");
    expect(downloaded).toBe(code);
    console.log("[stage] downloaded");

    // Syntax validate, then execute against the LOCAL demo → PASS.
    expect(syntaxOk(code)).toBe(true);
    const passResult = await runGeneratedSpec(code, "pass");
    expect(passResult.output).toContain("passed");
    expect(passResult.passed).toBe(true);
    console.log("[stage] positive-passed");

    // Negative control: same steps without the failure → assertion FAILS.
    const stub = await startFailureFreeStub();
    try {
      const negativeCode = code.split(DEMO_URL).join(stub.origin);
      expect(negativeCode).not.toContain(DEMO_URL);
      const failResult = await runGeneratedSpec(negativeCode, "negative");
      expect(failResult.passed).toBe(false);
      console.log("[stage] negative-failed-as-expected");
    } finally {
      await stub.stop();
    }

    // Regenerate → second immutable history row.
    const regenerateButton = page.getByRole("button", {
      name: "Generate again",
    });
    await expect(regenerateButton).toBeVisible({ timeout: 15_000 });
    await regenerateButton.click();
    const history = await waitForHistoryCount(apiCtx, cookies, issue.id, 2);
    expect(history).toHaveLength(2);
    console.log("[stage] regenerated");
    await expect(page.getByText(/History \(2\)/)).toBeVisible({
      timeout: 30_000,
    });

    // Viewer: inspect (read, copy, download) but not generate.
    const viewerCtx = await request.newContext({ baseURL: API });
    try {
      const signup = await viewerCtx.post("/api/auth/sign-up/email", {
        data: { email: viewerEmail, password: E2E_PASSWORD, name: "Viewer" },
      });
      expect(signup.ok()).toBeTruthy();
      const viewerPool = db();
      try {
        const userRow = await viewerPool.query(
          `SELECT id FROM "user" WHERE email = $1`,
          [viewerEmail],
        );
        const viewerId = (userRow.rows[0] as { id: string }).id;
        const projRow = await viewerPool.query(
          `SELECT workspace_id FROM projects WHERE id = $1`,
          [projectId],
        );
        const workspaceId = (projRow.rows[0] as { workspace_id: string })
          .workspace_id;
        await viewerPool.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role)
           VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
          [workspaceId, viewerId],
        );
      } finally {
        await viewerPool.end();
      }
    } finally {
      await viewerCtx.dispose();
    }
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(viewerEmail);
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
    await page.goto(`/app/projects/${projectId}/issues/${issue.id}`);
    await expect(
      page.getByRole("heading", { name: /after navigation and click/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/can inspect, copy and download, but cannot generate/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Generate reproduction" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Generate again" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download", exact: true }),
    ).toBeVisible();

    const viewerApi = await request.newContext({ baseURL: API });
    try {
      const signin = await viewerApi.post("/api/auth/sign-in/email", {
        data: { email: viewerEmail, password: E2E_PASSWORD },
      });
      expect(signin.ok()).toBeTruthy();
      const viewerCookies = cookiesFromHeaders(await signin.headersArray());
      const firstEvent = history[0];
      if (firstEvent === undefined) {
        throw new Error("reproduction history is empty");
      }
      const forbidden = await viewerApi.post(
        `/api/v1/events/${firstEvent.eventId}/reproductions`,
        {
          headers: {
            cookie: viewerCookies,
            "Idempotency-Key": "e2e-viewer-denied",
          },
        },
      );
      expect(forbidden.status()).toBe(403);
      console.log("[stage] viewer-403");
    } finally {
      await viewerApi.dispose();
    }
  } finally {
    await demoContext?.close().catch(() => undefined);
    await demo?.stop().catch(() => undefined);
    await worker?.stop().catch(() => undefined);
    await apiCtx.dispose();
  }
});
