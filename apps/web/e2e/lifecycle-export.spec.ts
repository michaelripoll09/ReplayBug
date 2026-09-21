import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

/**
 * Requires the real API, web server, and PostgreSQL fixture from
 * playwright.config.ts. The issue/event rows are inserted directly because
 * worker processing is outside this focused export/UI lifecycle check.
 */

async function registerAndOnboard(page: Page, email: string): Promise<string> {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Lifecycle owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });
  await page.getByLabel("Workspace name").fill("Lifecycle WS");
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });
  await page.getByLabel("Project name").fill("Lifecycle Project");
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
  const projectId = new URL(page.url()).searchParams.get("projectId");
  if (projectId === null || projectId.length === 0) {
    throw new Error("onboarding did not provide a projectId");
  }
  return projectId;
}

async function projectSlug(projectId: string): Promise<string> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    const result = await pool.query(`SELECT slug FROM projects WHERE id = $1`, [
      projectId,
    ]);
    const slug = result.rows[0]?.slug as string | undefined;
    if (slug === undefined) {
      throw new Error("project fixture was not created");
    }
    return slug;
  } finally {
    await pool.end();
  }
}

async function publishIssue(
  projectId: string,
): Promise<{ issueId: string; eventId: string }> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    const issueId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO issues
         ("id", "project_id", "fingerprint", "fingerprint_signature",
          "type", "title", "normalized_message", "status", "severity",
          "first_seen_at", "last_seen_at", "occurrence_count",
          "affected_session_count")
       VALUES ($1, $2, $3, 'lifecycle-signature', 'exception',
               'Lifecycle export failure', 'Cannot read lifecycle value',
               'open', 'error', now(), now(), 1, 1)`,
      [issueId, projectId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, $3, 'production',
               'https://example.com/lifecycle', 'e2e@1')`,
      [sessionId, projectId, `session-${issueId}`],
    );
    await pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at", "environment",
          "release", "page_url", "payload_json", "issue_id",
          "processing_state")
       VALUES ($1, $2, $3, $4, 1, 'exception', now(), 'production',
               'web@e2e', 'https://example.com/lifecycle', $5, $6, 'processed')`,
      [
        eventId,
        projectId,
        sessionId,
        crypto.randomUUID(),
        JSON.stringify({
          values: [
            {
              type: "TypeError",
              value: "Cannot read lifecycle value",
              stacktrace: {
                frames: [
                  {
                    filename: "https://example.com/app.js",
                    function: "renderLifecycle",
                    lineno: 12,
                    colno: 4,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        }),
        issueId,
      ],
    );
    return { issueId, eventId };
  } finally {
    await pool.end();
  }
}

test("issue export preserves the selected occurrence and project lifecycle labels", async ({
  page,
}) => {
  await resetE2EDatabase();
  const email = uniqueEmail("lifecycle-export");
  const projectId = await registerAndOnboard(page, email);
  const { issueId, eventId } = await publishIssue(projectId);
  const slug = await projectSlug(projectId);
  const exportRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/api/v1/issues/${issueId}/export`)) {
      exportRequests.push(request.url());
    }
  });

  await page.goto(
    `/app/projects/${projectId}/issues/${issueId}?event=${eventId}`,
  );
  await expect(
    page.getByRole("heading", { name: "Lifecycle export failure" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/Lifetime aggregate totals: 1 occurrences/),
  ).toBeVisible();
  await expect(page.getByText(/1 affected sessions/)).toBeVisible();
  await expect(
    page.getByText(/currently retained occurrences and sessions/),
  ).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.getByRole("button", { name: "Export issue" }).click(),
  ]);
  expect(await download.suggestedFilename()).toBe(
    `replaybug-issue-${issueId}.json`,
  );
  const downloadPath = await download.path();
  if (downloadPath === null) {
    throw new Error("issue export download has no path");
  }
  const downloaded = readFileSync(downloadPath, "utf8");
  expect(downloaded).toContain(`"id":"${issueId}"`);
  expect(exportRequests).toHaveLength(1);
  expect(exportRequests[0]).toContain(`eventId=${eventId}`);
  expect(page.url()).toContain(`event=${eventId}`);

  await page.goto(`/app/projects/${projectId}/settings`);
  await expect(page.getByLabel("Retention (days, 7–365)")).toHaveValue("30");
  await expect(
    page.getByText(
      /Raw telemetry and events are retained for this configured period/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Issue aggregates, comments\/activity, reproductions, affected-session lifetime counters, and audit history may remain longer according to policy/,
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete project…" }).click();
  const confirmation = page.getByLabel("Project slug");
  const deleteProject = page.getByRole("button", {
    name: "Delete project",
    exact: true,
  });
  await confirmation.fill("Lifecycle Project");
  await expect(deleteProject).toBeDisabled();
  await confirmation.fill(slug);
  await expect(deleteProject).toBeEnabled();
  await expect(
    page.getByRole("dialog").getByText(/irreversible.*durable.*asynchronous/s),
  ).toBeVisible();
});
