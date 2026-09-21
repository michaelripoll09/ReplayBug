import {
  REPRODUCTION_OUTPUT_TOO_LARGE,
  ReproductionError,
} from "./base-url.js";
import { safeCommentFragment, tsSingleQuoteLiteral } from "./escaping.js";
import type { GeneratedReproduction, ReproductionPlan } from "./types.js";

const MAX_CODE_BYTES = 256 * 1024;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function testTitle(issueId: string, issueTitle: string): string {
  const clean = issueTitle.replace(/\s+/g, " ").trim().slice(0, 80);
  return `ReplayBug issue ${shortId(issueId)} — ${clean === "" ? "reproduction" : clean}`;
}

/**
 * Render a validated plan into deterministic portable Playwright TypeScript.
 * Output needs only `@playwright/test` + built-ins. LF canonical.
 */
export function renderPlaywrightTest(
  plan: ReproductionPlan,
): GeneratedReproduction {
  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(``);
  lines.push(`// ReplayBug reproduction (generator ${plan.generatorVersion})`);
  lines.push(
    `// issue: ${shortId(plan.issueId)} | occurrence: ${shortId(plan.occurrenceEventId)} | env: ${safeCommentFragment(plan.environment, 64)}${plan.release !== undefined ? ` | release: ${safeCommentFragment(plan.release, 64)}` : ""}`,
  );
  if (plan.hasRedactedSteps) {
    lines.push(
      `// WARNING: some required values were redacted. Replace REPLACE_WITH_TEST_VALUE before running.`,
    );
  }
  for (const w of plan.warnings.slice(0, 10)) {
    lines.push(`// warning: ${safeCommentFragment(w, 200)}`);
  }
  lines.push(``);
  lines.push(`function normalizeObservedMessage(value: string): string {`);
  lines.push(`  return value`);
  lines.push(
    `    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')`,
  );
  lines.push(`    .replace(/\\b[0-9a-f]{16,64}\\b/gi, ':id')`);
  lines.push(`    .replace(/\\b\\d{6,}\\b/g, ':id')`);
  lines.push(
    `    .replace(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?/g, ':time')`,
  );
  lines.push(`    .replace(/\\?[^\\s'"]*/g, '?…')`);
  lines.push(`    .replace(/0x[0-9a-f]+/gi, ':addr')`);
  lines.push(`    .replace(/\\s+/g, ' ')`);
  lines.push(`    .trim()`);
  lines.push(`    .slice(0, 2000);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(
    `test(${tsSingleQuoteLiteral(testTitle(plan.issueId, plan.issueTitle))}, async ({ page }) => {`,
  );

  // Failure collectors registered BEFORE navigation/actions.
  switch (plan.assertion.kind) {
    case "pageerror": {
      lines.push(`  const pageErrors: string[] = [];`);
      lines.push(
        `  page.on('pageerror', (error) => { pageErrors.push(String((error as Error)?.message ?? error)); });`,
      );
      break;
    }
    case "console_error": {
      lines.push(`  const consoleErrors: string[] = [];`);
      lines.push(
        `  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });`,
      );
      break;
    }
    case "network": {
      lines.push(`  const matchingResponses: Array<{ status: number }> = [];`);
      lines.push(
        `  page.on('response', (response) => { try { const url = new URL(response.url()); if (response.request().method() === ${tsSingleQuoteLiteral(plan.assertion.method)} && url.pathname === ${tsSingleQuoteLiteral(plan.assertion.route)}) matchingResponses.push({ status: response.status() }); } catch { /* ignore */ } });`,
      );
      break;
    }
  }
  lines.push(``);
  lines.push(
    `  await page.goto(${tsSingleQuoteLiteral(`${plan.baseUrl}${plan.startRoute}`)});`,
  );

  for (const action of plan.actions) {
    switch (action.kind) {
      case "navigate": {
        lines.push(
          `  await page.goto(${tsSingleQuoteLiteral(`${plan.baseUrl}${action.route}`)});`,
        );
        break;
      }
      case "expectUrl": {
        lines.push(
          `  await expect(page).toHaveURL(${tsSingleQuoteLiteral(`**${action.route}`)});`,
        );
        break;
      }
      case "click": {
        if (action.brittle) {
          lines.push(
            `  // ReplayBug warning: brittle locator; verify stability.`,
          );
        }
        lines.push(`  await ${action.locatorExpression}.click();`);
        break;
      }
      case "fill": {
        if (action.redacted) {
          lines.push(
            `  // ReplayBug could not capture this value because input data is redacted.`,
          );
          lines.push(
            `  await ${action.locatorExpression}.fill('REPLACE_WITH_TEST_VALUE');`,
          );
        } else {
          lines.push(
            `  await ${action.locatorExpression}.fill(${tsSingleQuoteLiteral(action.value ?? "")});`,
          );
        }
        break;
      }
    }
  }

  for (const d of plan.diagnostics.slice(0, 20)) {
    lines.push(`  // ${safeCommentFragment(d, 240)}`);
  }
  lines.push(``);

  // Assertions poll briefly: failures such as delayed uncaught errors or
  // async network responses may arrive after the last replayed action.
  // expect.poll keeps the test deterministic (bounded 10s) without sleeps,
  // and still fails when the expected failure never occurs.
  switch (plan.assertion.kind) {
    case "pageerror": {
      const expected =
        plan.assertion.expectedMessage ?? plan.assertion.expectedType ?? "";
      lines.push(
        `  const expected = normalizeObservedMessage(${tsSingleQuoteLiteral(expected)});`,
      );
      lines.push(
        `  await expect.poll(async () => pageErrors.map((m) => normalizeObservedMessage(m)).some((m) => m.includes(expected) || expected.includes(m)), { timeout: 10000 }).toBe(true);`,
      );
      break;
    }
    case "console_error": {
      const expected = plan.assertion.expectedMessage ?? "";
      lines.push(
        `  const expected = normalizeObservedMessage(${tsSingleQuoteLiteral(expected)});`,
      );
      lines.push(
        `  await expect.poll(async () => consoleErrors.map((m) => normalizeObservedMessage(m)).some((m) => m.includes(expected) || expected.includes(m)), { timeout: 10000 }).toBe(true);`,
      );
      break;
    }
    case "network": {
      if (
        plan.assertion.statusCode !== null &&
        plan.assertion.statusCode !== undefined
      ) {
        lines.push(
          `  await expect.poll(async () => matchingResponses.some((r) => r.status === ${plan.assertion.statusCode}), { timeout: 10000 }).toBe(true);`,
        );
      } else {
        lines.push(
          `  await expect.poll(async () => matchingResponses.length, { timeout: 10000 }).toBeGreaterThan(0);`,
        );
      }
      break;
    }
  }
  lines.push(`});`);
  lines.push(``);

  const code = lines.join("\n");
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new ReproductionError(
      REPRODUCTION_OUTPUT_TOO_LARGE,
      "Generated test exceeds size bound.",
    );
  }
  return {
    code,
    hasRedactedSteps: plan.hasRedactedSteps,
    warnings: plan.warnings,
  };
}

export const __renderHooks = { MAX_CODE_BYTES };
