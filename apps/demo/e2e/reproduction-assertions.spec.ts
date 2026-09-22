import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  buildReproductionPlan,
  renderPlaywrightTest,
  validateGeneratedSyntax,
  type FailureEvidence,
  type GenerationInput,
  type TimelineEvidenceItem,
} from "@replaybug/reproducer";
import { e2eFixture, pollUntil, withPool } from "./helpers";

const fixture = e2eFixture();

// Tracing is off for this file: the safe-input test spawns a nested
// Playwright run inside the test, and on Windows the outer trace
// finalization races with the nested browser (ENOENT on .network trace
// files), masking real results as teardown failures. CI/Linux is
// unaffected; the nested run still validates generated tests end to end.
test.use({ trace: "off" });

const SAFE_VALUE = "SAFE_REPLAYBUG_E2E_VALUE_92841";
const PASSWORD_SECRET = "PRIVATE_PASSWORD_E2E_92841";
const MASKED_SECRET = "PRIVATE_MASKED_E2E_92841";
const PRIVACY_EXCEPTION = "DEMO: Privacy form submitted";
const UNCAUGHT_EXCEPTION = "DEMO: Uncaught error after navigation and click";

interface SessionEventRow {
  id: string;
  telemetry_session_id: string;
  sequence_number: number;
  event_type: string;
  occurred_at: Date;
  page_url: string | null;
  payload_json: Record<string, unknown>;
}

async function fetchEventsSince(since: Date): Promise<SessionEventRow[]> {
  return withPool(async (pool) => {
    const res = await pool.query(
      `SELECT id, telemetry_session_id, sequence_number, event_type,
              occurred_at, page_url, payload_json
       FROM events
       WHERE project_id = $1 AND received_at >= $2
       ORDER BY occurred_at, sequence_number`,
      [fixture.projectId, since],
    );
    return res.rows as SessionEventRow[];
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toTimelineItem(row: SessionEventRow): TimelineEvidenceItem {
  const base: TimelineEvidenceItem = {
    sequenceNumber: row.sequence_number,
    occurredAt: toIso(row.occurred_at),
    id: row.id,
    eventType: row.event_type,
    payload: row.payload_json,
  };
  if (row.page_url !== null) {
    return { ...base, pageUrl: row.page_url };
  }
  return base;
}

function privacyFailure(): FailureEvidence {
  return {
    kind: "exception",
    expectedType: "Error",
    expectedMessage: PRIVACY_EXCEPTION,
  };
}

function generationInput(
  timeline: TimelineEvidenceItem[],
  occurrenceEventId: string,
): GenerationInput {
  return {
    issueId: randomUUID(),
    issueTitle: PRIVACY_EXCEPTION,
    issueType: "exception",
    occurrenceEventId,
    environment: "e2e",
    release: "demo-e2e@0.1.0",
    baseUrl: fixture.origin,
    timeline,
    failure: privacyFailure(),
  };
}

/**
 * Runs one generated spec with the package's own Playwright (nested run).
 * The generated code is written to a TEMP dir (proof artifact, never in the
 * repo); a minimal no-servers config lives next to this suite so module
 * resolution works and points testDir at the TEMP dir. The outer run's demo
 * server on :5173 stays up; the nested config starts no servers. Temp files
 * are removed afterwards.
 */
async function runSpecAgainstDemo(
  code: string,
  label: string,
): Promise<{ passed: boolean; output: string }> {
  const suffix = randomUUID().slice(0, 8);
  const specName = `repro.safe.spec.ts`;
  const configName = `repro-tmp-${label}-${suffix}.config.ts`;
  const e2eDir = dirname(new URL(import.meta.url).pathname).replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  const packageDir = dirname(e2eDir);
  const workDir = mkdtempSync(join(tmpdir(), `replaybug-demo-${label}-`));
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
      output += `\n[timeout after 180000ms]`;
      cleanup();
      resolvePromise({ passed: false, output });
    }, 180_000);
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

test.describe("Reproduction assertions E2E (real browser → SDK → API → PostgreSQL)", () => {
  test("failed-fetch 500 is observed as a network event", async ({ page }) => {
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    await page.getByTestId("demo-failed-fetch").click();

    const network = await pollUntil(async () => {
      const events = await fetchEventsSince(testStart);
      const match = events.find(
        (e) =>
          e.event_type === "network" &&
          (e.payload_json["status_code"] as number | null) === 500 &&
          String(e.payload_json["url"] as string).includes(
            "/api/demo/500-endpoint",
          ),
      );
      return match ?? null;
    });
    expect(network.payload_json["status_code"]).toBe(500);
    expect(String(network.payload_json["url"])).toContain(
      "/api/demo/500-endpoint",
    );

    // Generate from the observed timeline and execute: the generated test
    // must observe and assert the same network failure locally.
    test.setTimeout(240_000);
    const networkTimeline = (await fetchEventsSince(testStart))
      .filter((e) => e.sequence_number <= network.sequence_number)
      .map(toTimelineItem);
    expect(
      networkTimeline.some(
        (item) =>
          item.eventType === "click" &&
          JSON.stringify(item.payload).includes("demo-failed-fetch"),
      ),
    ).toBe(true);
    const networkPlan = buildReproductionPlan({
      issueId: randomUUID(),
      issueTitle: "demo failed fetch",
      issueType: "network",
      occurrenceEventId: network.id,
      environment: "e2e",
      release: "demo-e2e@0.1.0",
      baseUrl: fixture.origin,
      timeline: networkTimeline,
      failure: {
        kind: "network",
        method: String(network.payload_json["method"] ?? "GET"),
        url: String(network.payload_json["url"] ?? "/api/demo/500-endpoint"),
        statusCode:
          typeof network.payload_json["status_code"] === "number"
            ? (network.payload_json["status_code"] as number)
            : 500,
      },
    });
    expect(networkPlan.assertion).toMatchObject({
      kind: "network",
      statusCode: 500,
    });
    const networkGen = renderPlaywrightTest(networkPlan);
    expect(networkGen.code).toContain("/api/demo/500-endpoint");
    expect(networkGen.code).toContain("500");
    expect(validateGeneratedSyntax(networkGen.code).ok).toBe(true);
    const networkResult = await runSpecAgainstDemo(networkGen.code, "network");
    if (!networkResult.passed) {
      console.log(
        `[network-nested-output]\n${networkResult.output.slice(-4000)}`,
      );
    }
    expect(networkResult.output).toContain("passed");
    expect(networkResult.passed).toBe(true);
  });

  test("console-error is observed as a console_error event", async ({
    page,
  }) => {
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    await page.getByTestId("demo-console-error").click();

    const consoleError = await pollUntil(async () => {
      const events = await fetchEventsSince(testStart);
      const match = events.find(
        (e) =>
          e.event_type === "console_error" &&
          JSON.stringify(e.payload_json).includes("Intentional console.error"),
      );
      return match ?? null;
    });
    expect(JSON.stringify(consoleError.payload_json)).toContain(
      "Intentional console.error",
    );

    // Generate from the observed timeline and execute: the generated test
    // must observe the matching error-level console output locally.
    test.setTimeout(240_000);
    const consoleTimeline = (await fetchEventsSince(testStart))
      .filter((e) => e.sequence_number <= consoleError.sequence_number)
      .map(toTimelineItem);
    const consolePlan = buildReproductionPlan({
      issueId: randomUUID(),
      issueTitle: "demo console error",
      issueType: "console_error",
      occurrenceEventId: consoleError.id,
      environment: "e2e",
      release: "demo-e2e@0.1.0",
      baseUrl: fixture.origin,
      timeline: consoleTimeline,
      failure: {
        kind: "console_error",
        expectedMessage: "DEMO: Intentional console.error",
      },
    });
    const consoleGen = renderPlaywrightTest(consolePlan);
    expect(consoleGen.code).toContain("page.on('console'");
    expect(consoleGen.code).toContain("DEMO: Intentional console.error");
    expect(validateGeneratedSyntax(consoleGen.code).ok).toBe(true);
    const consoleResult = await runSpecAgainstDemo(consoleGen.code, "console");
    if (!consoleResult.passed) {
      console.log(
        `[console-nested-output]\n${consoleResult.output.slice(-4000)}`,
      );
    }
    expect(consoleResult.output).toContain("passed");
    expect(consoleResult.passed).toBe(true);
  });

  test("redacted inputs stay placeholders; safe input executes", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    await page.getByPlaceholder(SAFE_VALUE).fill(SAFE_VALUE);
    await page.getByPlaceholder(PASSWORD_SECRET).fill(PASSWORD_SECRET);
    await page.getByPlaceholder(MASKED_SECRET).fill(MASKED_SECRET);
    await page
      .getByRole("button", { name: /Submit & Trigger Exception/ })
      .click();
    await expect(page.getByText(/Privacy form submitted/)).toBeVisible();

    // All of this test's telemetry is persisted (scoped by time).
    const persisted = await pollUntil(async () => {
      const events = await fetchEventsSince(testStart);
      const hasException = events.some(
        (e) =>
          e.event_type === "exception" &&
          JSON.stringify(e.payload_json).includes(PRIVACY_EXCEPTION),
      );
      const hasSafeInput = events.some(
        (e) =>
          e.event_type === "input" &&
          JSON.stringify(e.payload_json).includes(SAFE_VALUE),
      );
      return hasException && hasSafeInput ? events : null;
    });

    // Secrets never persist anywhere for this project.
    const leaked = await withPool(async (pool) => {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS count FROM events
         WHERE project_id = $1
           AND (row_to_json(events)::text LIKE $2
                OR row_to_json(events)::text LIKE $3)`,
        [fixture.projectId, `%${PASSWORD_SECRET}%`, `%${MASKED_SECRET}%`],
      );
      return (res.rows[0] as { count: number }).count;
    });
    expect(leaked).toBe(0);

    // The safe value persists only in safe-selector input events.
    const safeRows = persisted.filter(
      (e) =>
        e.event_type === "input" &&
        JSON.stringify(e.payload_json).includes(SAFE_VALUE),
    );
    expect(safeRows.length).toBeGreaterThan(0);
    for (const row of safeRows) {
      expect(row.payload_json["is_safe_selector_match"]).toBe(true);
    }

    const occurrence = persisted.find(
      (e) =>
        e.event_type === "exception" &&
        JSON.stringify(e.payload_json).includes(PRIVACY_EXCEPTION),
    );
    if (occurrence === undefined) {
      throw new Error("privacy exception event missing from timeline");
    }
    const fullTimeline = persisted.map(toTimelineItem);

    // Redacted variant: full timeline (includes sensitive inputs). The
    // generated code must carry the placeholder and never the secret.
    // This placeholder test is NEVER executed — it needs a manual value.
    const redactedPlan = buildReproductionPlan(
      generationInput(fullTimeline, occurrence.id),
    );
    const redacted = renderPlaywrightTest(redactedPlan);
    expect(redacted.hasRedactedSteps).toBe(true);
    expect(redacted.code).toContain("REPLACE_WITH_TEST_VALUE");
    expect(redacted.code).not.toContain(PASSWORD_SECRET);
    expect(redacted.code).not.toContain(MASKED_SECRET);
    expect(validateGeneratedSyntax(redacted.code).ok).toBe(true);

    // Safe variant: a fresh flow where the failure is a REAL uncaught
    // pageerror. Fill the safe input, then trigger the uncaught-error
    // scenario; the generated test replays fill + click and must PASS by
    // observing the pageerror.
    const safeStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );
    await page.getByPlaceholder(SAFE_VALUE).fill(SAFE_VALUE);
    await page.getByTestId("demo-uncaught-error").click();
    const uncaught = await pollUntil(async () => {
      const events = await fetchEventsSince(safeStart);
      const match = events.find(
        (e) =>
          e.event_type === "exception" &&
          JSON.stringify(e.payload_json).includes(UNCAUGHT_EXCEPTION),
      );
      return match ?? null;
    });
    const safePersisted = await fetchEventsSince(safeStart);
    const safeTimeline = safePersisted
      .filter((e) => e.sequence_number <= uncaught.sequence_number)
      .filter((e) => {
        if (e.event_type === "input") {
          const serialized = JSON.stringify(e.payload_json);
          return (
            serialized.includes(SAFE_VALUE) &&
            !serialized.includes(PASSWORD_SECRET) &&
            !serialized.includes(MASKED_SECRET)
          );
        }
        return true;
      })
      .map(toTimelineItem);
    // The safe input event itself must survive filtering.
    expect(
      safeTimeline.some(
        (item) =>
          item.eventType === "input" &&
          JSON.stringify(item.payload).includes(SAFE_VALUE),
      ),
    ).toBe(true);
    const safePlan = buildReproductionPlan({
      issueId: randomUUID(),
      issueTitle: UNCAUGHT_EXCEPTION,
      issueType: "exception",
      occurrenceEventId: uncaught.id,
      environment: "e2e",
      release: "demo-e2e@0.1.0",
      baseUrl: fixture.origin,
      timeline: safeTimeline,
      failure: {
        kind: "exception",
        expectedType: "Error",
        expectedMessage: UNCAUGHT_EXCEPTION,
      },
    });
    const safe = renderPlaywrightTest(safePlan);
    expect(safe.hasRedactedSteps).toBe(false);
    expect(safe.code).toContain(SAFE_VALUE);
    expect(safe.code).not.toContain("REPLACE_WITH_TEST_VALUE");
    expect(safe.code).toContain("getByTestId('demo-uncaught-error')");
    expect(validateGeneratedSyntax(safe.code).ok).toBe(true);

    const result = await runSpecAgainstDemo(safe.code, "safe");
    if (!result.passed || !result.output.includes("passed")) {
      console.log(`[safe-nested-output]\n${result.output.slice(-4000)}`);
    }
    expect(result.output).toContain("passed");
    expect(result.passed).toBe(true);
  });
});
