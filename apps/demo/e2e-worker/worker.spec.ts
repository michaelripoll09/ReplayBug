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
  severity: string;
  fingerprint: string;
  fingerprint_signature: string;
  occurrence_count: number;
  affected_session_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

async function fetchDemoTypeErrorIssue(): Promise<IssueRow | null> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT id, title, status, type, severity, fingerprint,
              fingerprint_signature, occurrence_count, affected_session_count,
              first_seen_at, last_seen_at
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

async function clearFixtureProjectTelemetry(): Promise<void> {
  await withPool(async (pool) => {
    // Issue-owned records cascade from issues; event/outbox records cascade
    // from telemetry sessions. The ingest key and project configuration stay.
    await pool.query(`DELETE FROM issues WHERE project_id = $1`, [
      fixture.projectId,
    ]);
    await pool.query(`DELETE FROM telemetry_sessions WHERE project_id = $1`, [
      fixture.projectId,
    ]);
  });
}

async function fetchNavigationClickIssue(): Promise<IssueRow | null> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT id, title, status, type, severity, fingerprint,
              fingerprint_signature, occurrence_count, affected_session_count,
              first_seen_at, last_seen_at
       FROM issues
       WHERE project_id = $1 AND title LIKE '%after navigation and click%'
       ORDER BY created_at DESC
       LIMIT 1`,
      [fixture.projectId],
    );
    const row = result.rows[0] as IssueRow | undefined;
    return row ?? null;
  });
}

interface GroupedEventRow {
  id: string;
  telemetry_session_id: string;
  issue_id: string | null;
  fingerprint: string | null;
  fingerprint_signature: string | null;
  processing_state: string;
}

async function fetchNavigationClickEvents(
  since: Date,
): Promise<GroupedEventRow[]> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT e.id, e.telemetry_session_id, e.issue_id, e.fingerprint,
              e.processing_state, i.fingerprint_signature
       FROM events e
       LEFT JOIN issues i ON i.id = e.issue_id
       WHERE e.project_id = $1 AND e.received_at >= $2
         AND e.event_type = 'exception'
       ORDER BY e.received_at`,
      [fixture.projectId, since],
    );
    return result.rows as GroupedEventRow[];
  });
}

async function fetchSessionEventTypes(sessionId: string): Promise<string[]> {
  return withPool(async (pool) => {
    const result = await pool.query(
      `SELECT event_type FROM events
       WHERE project_id = $1 AND telemetry_session_id = $2
       ORDER BY sequence_number, occurred_at, id`,
      [fixture.projectId, sessionId],
    );
    return result.rows.map((row: { event_type: string }) => row.event_type);
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

  test("groups repeated browser failures into one deterministic issue", async ({
    browser,
  }) => {
    // This test owns both its data and worker lifecycle, so it does not depend
    // on the browser session or worker state left by the preceding test.
    await stopWorker();
    await clearFixtureProjectTelemetry();
    await startWorker();
    const testStart = new Date();

    // Three independent browser contexts create three SDK sessions. Each runs
    // the real navigation → click → uncaught exception scenario exactly once.
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto("/");
        await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
          "Enabled",
        );
        await page.evaluate((index) => {
          window.location.hash = `e2e-grouping-${index}`;
        }, index);
        await page.getByTestId("demo-nav-click-error").click();
        await expect(
          page.getByText("Navigation → Click → Error captured"),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    }

    const issue = await pollUntil(
      async () => {
        const current = await fetchNavigationClickIssue();
        return current?.occurrence_count === 3 &&
          current.affected_session_count === 3
          ? current
          : null;
      },
      90_000,
      250,
    );

    expect(issue.status).toBe("open");
    expect(issue.type).toBe("exception");
    expect(issue.severity).toBe("error");
    expect(issue.occurrence_count).toBe(3);
    expect(issue.affected_session_count).toBe(3);
    expect(issue.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.fingerprint_signature).toContain(
      "DEMO: Error after navigation and click",
    );
    expect(new Date(issue.first_seen_at).getTime()).toBeLessThanOrEqual(
      new Date(issue.last_seen_at).getTime(),
    );

    const events = await pollUntil(
      async () => {
        const current = await fetchNavigationClickEvents(testStart);
        return current.length === 3 &&
          current.every(
            (event) =>
              event.processing_state === "processed" &&
              event.issue_id === issue.id &&
              event.fingerprint === issue.fingerprint &&
              event.fingerprint_signature === issue.fingerprint_signature,
          )
          ? current
          : null;
      },
      90_000,
      250,
    );

    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.issue_id)).size).toBe(1);
    expect(new Set(events.map((event) => event.fingerprint)).size).toBe(1);
    expect(
      new Set(events.map((event) => event.fingerprint_signature)).size,
    ).toBe(1);

    const sessionIds = new Set(
      events.map((event) => event.telemetry_session_id),
    );
    expect(sessionIds.size).toBe(3);
    const timeline = await fetchSessionEventTypes([...sessionIds][0] as string);
    expect(timeline).toEqual(
      expect.arrayContaining(["navigation", "click", "exception"]),
    );
    expect(timeline.indexOf("navigation")).toBeLessThan(
      timeline.indexOf("click"),
    );
    expect(timeline.indexOf("click")).toBeLessThan(
      timeline.indexOf("exception"),
    );

    const duplicateCount = await withPool(async (pool) => {
      const result = await pool.query(
        `SELECT COUNT(*)::int AS count FROM issues
         WHERE project_id = $1 AND fingerprint = $2`,
        [fixture.projectId, issue.fingerprint],
      );
      return (result.rows[0] as { count: number }).count;
    });
    expect(duplicateCount).toBe(1);
  });
});
