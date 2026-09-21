import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { e2eFixture, pollUntil, withPool } from "../e2e/helpers";

/**
 * Block 5 worker E2E: real browser → SDK → ingest → outbox → pg-boss →
 * worker → fingerprint → issue, against real PostgreSQL.
 *
 * The worker process is spawned by this spec (not by the Playwright config)
 * so the first test can prove the durability guarantee end to end: telemetry
 * accepted while the worker is down stays pending and undispatched, and the
 * restarted worker drains it into an issue.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, "..", "..", "worker");
const WORKER_ENTRY = join(WORKER_DIR, "dist", "index.js");

const fixture = e2eFixture();
const DATABASE_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

test.setTimeout(150_000);

let worker: ChildProcess | null = null;
let workerOutput = "";

async function startWorker(): Promise<void> {
  if (!existsSync(WORKER_ENTRY)) {
    throw new Error(
      `Worker build missing at ${WORKER_ENTRY}. Run "pnpm build" before the worker E2E.`,
    );
  }
  workerOutput = "";
  const child = spawn(process.execPath, [WORKER_ENTRY], {
    cwd: WORKER_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      REPLAYBUG_DATABASE_URL: DATABASE_URL,
      REPLAYBUG_OUTBOX_POLL_MS: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker = child;
  child.stdout?.on("data", (chunk: Buffer) => {
    workerOutput += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    workerOutput += chunk.toString("utf8");
  });
  await pollUntil(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Worker exited during startup.\n${workerOutput}`);
      }
      return workerOutput.includes("ReplayBug worker started") ? true : null;
    },
    30_000,
    200,
  );
}

async function stopWorker(): Promise<void> {
  const child = worker;
  worker = null;
  if (!child || child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

test.afterAll(async () => {
  await stopWorker();
});

interface ExceptionEventRow {
  id: string;
  processing_state: string;
  fingerprint: string | null;
  issue_id: string | null;
  dispatched_at: string | null;
}

async function fetchExceptionEvent(
  since: Date,
): Promise<ExceptionEventRow | null> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT e.id, e.processing_state, e.fingerprint, e.issue_id,
              o.dispatched_at
       FROM events e
       LEFT JOIN event_processing_outbox o ON o.event_id = e.id
       WHERE e.project_id = $1 AND e.received_at >= $2
         AND e.event_type = 'exception'
       ORDER BY e.received_at DESC
       LIMIT 1`,
      [fixture.projectId, since],
    );
    const row = result.rows[0] as ExceptionEventRow | undefined;
    return row ?? null;
  });
}

interface IssueRow {
  id: string;
  title: string;
  status: string;
  type: string;
  fingerprint: string;
  fingerprint_signature: string;
  occurrence_count: number;
  affected_session_count: number;
}

async function fetchDemoTypeErrorIssue(): Promise<IssueRow | null> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT id, title, status, type, fingerprint, fingerprint_signature,
              occurrence_count, affected_session_count
       FROM issues
       WHERE project_id = $1 AND title LIKE '%Cannot read properties of null%'
       ORDER BY created_at
       LIMIT 1`,
      [fixture.projectId],
    );
    const row = result.rows[0] as IssueRow | undefined;
    return row ?? null;
  });
}

test.describe("Block 5 worker E2E (browser → ingest → outbox → pg-boss → worker → issue)", () => {
  test("drains a browser exception accepted while the worker was down into an issue", async ({
    page,
  }) => {
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    await page
      .getByRole("button", { name: /1\. JavaScript Exception/ })
      .click();
    await expect(page.getByText(/Exception captured:/)).toBeVisible();

    // Worker is down: the accepted event is durable, pending and the outbox
    // row is not dispatched. Ingest never depends on the worker.
    const pending = await pollUntil(async () => fetchExceptionEvent(testStart));
    expect(pending.processing_state).toBe("pending");
    expect(pending.dispatched_at).toBeNull();
    expect(pending.issue_id).toBeNull();

    // Start the real worker: dispatcher + pg-boss + processor.
    await startWorker();

    const processed = await pollUntil(
      async () => {
        const event = await fetchExceptionEvent(testStart);
        return event?.processing_state === "processed" ? event : null;
      },
      60_000,
      250,
    );
    expect(processed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(processed.issue_id).not.toBeNull();
    expect(processed.dispatched_at).not.toBeNull();

    const issue = await pollUntil(async () => fetchDemoTypeErrorIssue());
    expect(issue.id).toBe(processed.issue_id);
    expect(issue.status).toBe("open");
    expect(issue.type).toBe("exception");
    expect(issue.occurrence_count).toBe(1);
    expect(issue.affected_session_count).toBe(1);
    expect(issue.fingerprint_signature).toContain("triggerJsException");

    // Exactly one issue for this fingerprint: no duplicate grouping.
    const duplicates = await withPool(async (pool) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM issues
         WHERE project_id = $1 AND fingerprint = $2`,
        [fixture.projectId, issue.fingerprint],
      );
      return (result.rows[0] as { count: number }).count;
    });
    expect(duplicates).toBe(1);
  });

  test("groups the same deterministic demo error across sessions without duplicates", async ({
    browser,
  }) => {
    const baseline = await fetchDemoTypeErrorIssue();
    expect(baseline).not.toBeNull();
    if (baseline === null) throw new Error("unreachable");

    // Two fresh browser contexts: two new SDK sessions, same defect.
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
        "Enabled",
      );
      await page
        .getByRole("button", { name: /1\. JavaScript Exception/ })
        .click();
      await expect(page.getByText(/Exception captured:/)).toBeVisible();
      await context.close();
    }

    const updated = await pollUntil(
      async () => {
        const issue = await fetchDemoTypeErrorIssue();
        return issue !== null &&
          issue.occurrence_count >= baseline.occurrence_count + 2
          ? issue
          : null;
      },
      90_000,
      250,
    );

    expect(updated.id).toBe(baseline.id);
    expect(updated.occurrence_count).toBe(baseline.occurrence_count + 2);
    expect(updated.affected_session_count).toBe(
      baseline.affected_session_count + 2,
    );

    const issueCount = await withPool(async (pool) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM issues
         WHERE project_id = $1 AND fingerprint = $2`,
        [fixture.projectId, baseline.fingerprint],
      );
      return (result.rows[0] as { count: number }).count;
    });
    expect(issueCount).toBe(1);
  });
});
