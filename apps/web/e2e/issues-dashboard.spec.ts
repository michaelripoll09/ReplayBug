import { test, expect, request, type Page } from "@playwright/test";
import { Pool } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * Block 6 dashboard E2E (T17) on the real stack (API + Web + PostgreSQL).
 *
 * Worker-boundary simulations are explicit: where the worker would commit
 * rows + pg_notify, the test writes the same rows + pg_notify directly and
 * says so. That keeps these tests deterministic without running the worker
 * (worker processing itself is covered by apps/demo e2e-worker).
 */

const API = "http://localhost:4001";
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

function db(): Pool {
  return new Pool({ connectionString: DB_URL });
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

async function onboardProject(
  page: Page,
  workspaceName: string,
  projectName: string,
): Promise<string> {
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

async function apiCookies(email: string): Promise<string> {
  const ctx = await request.newContext({ baseURL: API });
  try {
    const signin = await ctx.post("/api/auth/sign-in/email", {
      data: { email, password: E2E_PASSWORD },
    });
    if (!signin.ok()) {
      throw new Error(`signin failed: ${signin.status()}`);
    }
    return (await signin.headersArray())
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value.split(";")[0])
      .join("; ");
  } finally {
    await ctx.dispose();
  }
}

/** Simulates worker completion at the pg_notify boundary (rows + notify). */
async function publishIssue(
  projectId: string,
  fingerprintChar: string,
  title: string,
  opts: {
    status?: string;
    sessionSdk?: string;
    withTimeline?: boolean;
    hostile?: boolean;
  } = {},
): Promise<{ issueId: string; sessionId: string; eventId: string }> {
  const pool = db();
  try {
    const issueId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const status = opts.status ?? "open";
    const safeTitle = opts.hostile
      ? '<img src="x" onerror="window.__xss=1">Boom'
      : title;
    await pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, $3, 'sig', 'exception', $4, $4, $5, 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId, fingerprintChar.repeat(64), safeTitle, status],
    );
    await pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, $3, 'production', 'https://example.com/checkout', 't@0')`,
      [sessionId, projectId, opts.sessionSdk ?? `sdk-${issueId.slice(0, 8)}`],
    );
    const payload = opts.hostile
      ? {
          values: [
            {
              type: "TypeError",
              value:
                "<script>window.__xss=2</script>boom<script>alert(1)</script>",
              stacktrace: {
                frames: [
                  {
                    filename: "https://example.com/app.js",
                    function: "onClick",
                    lineno: 1,
                    colno: 2,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        }
      : {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of null",
              stacktrace: {
                frames: [
                  {
                    filename: "https://example.com/app.js",
                    function: "onClick",
                    lineno: 42,
                    colno: 7,
                    in_app: true,
                  },
                ],
              },
            },
          ],
        };
    if (opts.withTimeline === true) {
      const nav = async (seq: number, url: string): Promise<void> => {
        await pool.query(
          `INSERT INTO events
             ("project_id", "telemetry_session_id", "client_event_id",
              "sequence_number", "event_type", "occurred_at",
              "environment", "payload_json", "processing_state")
           VALUES ($1, $2, $3, $4, 'navigation', now() - interval '2 minutes',
                   'production', $5, 'processed')`,
          [
            projectId,
            sessionId,
            crypto.randomUUID(),
            seq,
            JSON.stringify({ to_url: url, navigation_type: "pushState" }),
          ],
        );
      };
      const click = async (seq: number): Promise<void> => {
        await pool.query(
          `INSERT INTO events
             ("project_id", "telemetry_session_id", "client_event_id",
              "sequence_number", "event_type", "occurred_at",
              "environment", "payload_json", "processing_state")
           VALUES ($1, $2, $3, $4, 'click', now() - interval '1 minute',
                   'production',
                   '{"element_tag":"button","locator_candidates":[]}',
                   'processed')`,
          [projectId, sessionId, crypto.randomUUID(), seq],
        );
      };
      await nav(1, "https://example.com/");
      await nav(2, "https://example.com/checkout");
      await click(3);
    }
    await pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "page_url", "payload_json",
          "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, $5, 'exception', now(),
               'production', 'web@2.0.0', 'https://example.com/checkout',
               $6, $7, 'processed')`,
      [
        eventId,
        projectId,
        sessionId,
        crypto.randomUUID(),
        opts.withTimeline === true ? 4 : 1,
        JSON.stringify(payload),
        issueId,
      ],
    );
    await pool.query(`SELECT pg_notify('replaybug_project_updates', $1)`, [
      JSON.stringify({
        version: 1,
        type: "issue.created",
        projectId,
        issueId,
        eventId,
      }),
    ]);
    return { issueId, sessionId, eventId };
  } finally {
    await pool.end();
  }
}

test("E2E-B6-1 live issue appears without reload, raw stack + timeline work", async ({
  page,
}) => {
  await resetE2EDatabase();
  const email = uniqueEmail("live");
  await registerViaUI(page, email, "Live");
  const projectId = await onboardProject(page, "Live WS", "live-proj");

  await page.goto(`/app/projects/${projectId}/issues`);
  await expect(page.getByText("No issues yet")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("status", { name: /Realtime updates/ }),
  ).toContainText("Live", { timeout: 15_000 });

  // Worker completion simulated at the pg_notify boundary.
  const { issueId } = await publishIssue(
    projectId,
    "a",
    "Checkout null-product failure",
    {
      withTimeline: true,
    },
  );

  // No reload: the SSE invalidation refreshes the list.
  await expect(page.getByText("Checkout null-product failure")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByText("Checkout null-product failure").click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issueId}`), {
    timeout: 15_000,
  });
  // Raw stack as inert text with the honest label.
  await expect(page.getByText(/Raw stack trace/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("TypeError: Cannot read properties of null").first(),
  ).toBeVisible();
  // Preceding navigation/click timeline around the occurrence.
  await expect(
    page.getByText("https://example.com/checkout").first(),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("View full session →")).toBeVisible();
  await page.getByText("View full session →").click();
  await expect(page).toHaveURL(/\/sessions\//, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: /Timeline \(4 events loaded\)/ }),
  ).toBeVisible({
    timeout: 15_000,
  });
});

test("E2E-B6-2 lifecycle, regression reopen, assignee notification", async ({
  page,
}) => {
  await resetE2EDatabase();
  const ownerEmail = uniqueEmail("lifecycle-owner");
  const memberEmail = uniqueEmail("lifecycle-member");
  await registerViaUI(page, ownerEmail, "Owner");
  const projectId = await onboardProject(page, "Cycle WS", "cycle-proj");

  // Second user becomes a workspace member via DB (no invitations in scope).
  const apiCtx = await request.newContext({ baseURL: API });
  const signup = await apiCtx.post("/api/auth/sign-up/email", {
    data: { email: memberEmail, password: E2E_PASSWORD, name: "Member" },
  });
  expect(signup.ok()).toBeTruthy();
  let memberId = "";
  const pool = db();
  try {
    const userRow = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      memberEmail,
    ]);
    memberId = userRow.rows[0].id as string;
    const projRow = await pool.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [projRow.rows[0].workspace_id, memberId],
    );
  } finally {
    await pool.end();
  }
  await apiCtx.dispose();

  const { issueId } = await publishIssue(projectId, "b", "Profile save 500");
  await page.goto(`/app/projects/${projectId}/issues/${issueId}`);
  await expect(
    page.getByRole("heading", { name: "Profile save 500" }),
  ).toBeVisible({ timeout: 15_000 });

  // Assign → tag → comment → resolve, all through the UI.
  await expect(page.getByLabel("Assign issue").locator("option")).toHaveCount(
    3,
    { timeout: 15_000 },
  );
  await page.getByLabel("Assign issue").selectOption(memberId);
  await expect(page.getByText("assigned to Member")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByPlaceholder("New tag…").fill("backend");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("backend").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Add a comment").fill("Reproduces on staging.");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText("Reproduces on staging.")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Change issue status").selectOption("resolved");
  await expect(page.getByText("Resolved").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("changed status open → resolved")).toBeVisible({
    timeout: 15_000,
  });

  // Regression simulated at the worker boundary: reopen + activity + notify.
  const pool2 = db();
  try {
    await pool2.query(
      `UPDATE issues SET status = 'open', resolved_at = NULL WHERE id = $1`,
      [issueId],
    );
    await pool2.query(
      `INSERT INTO issue_activity (issue_id, actor_user_id, type) VALUES ($1, NULL, 'regression_detected')`,
      [issueId],
    );
    const wsRow = await pool2.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    const memRow = await pool2.query(`SELECT id FROM "user" WHERE email = $1`, [
      memberEmail,
    ]);
    await pool2.query(
      `INSERT INTO notifications (user_id, workspace_id, project_id, issue_id, type, title, body)
       VALUES ($1, $2, $3, $4, 'issue_regression', 'Regression: Profile save 500', 'A resolved issue regressed.')`,
      [memRow.rows[0].id, wsRow.rows[0].workspace_id, projectId, issueId],
    );
    await pool2.query(`SELECT pg_notify('replaybug_project_updates', $1)`, [
      JSON.stringify({
        version: 1,
        type: "issue.regressed",
        projectId,
        issueId,
      }),
    ]);
  } finally {
    await pool2.end();
  }
  await expect(
    page.locator("span").getByText("Open", { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("Regression detected — issue reopened"),
  ).toBeVisible({
    timeout: 15_000,
  });

  // The assignee sees the assignment notification in the bell.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(memberEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: /Notifications, 2 unread/ }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Notifications/ }).click();
  await expect(page.getByText("Regression: Profile save 500")).toBeVisible();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
});

test("E2E-B6-3 viewer is read-only and direct mutations 403", async ({
  page,
}) => {
  await resetE2EDatabase();
  const ownerEmail = uniqueEmail("vowner");
  const viewerEmail = uniqueEmail("vviewer");
  await registerViaUI(page, ownerEmail, "Owner");
  const projectId = await onboardProject(page, "View WS", "view-proj");
  const { issueId } = await publishIssue(
    projectId,
    "c",
    "Async dashboard rejection",
  );

  const apiCtx = await request.newContext({ baseURL: API });
  const signup = await apiCtx.post("/api/auth/sign-up/email", {
    data: { email: viewerEmail, password: E2E_PASSWORD, name: "Viewer" },
  });
  expect(signup.ok()).toBeTruthy();
  const pool = db();
  try {
    const userRow = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      viewerEmail,
    ]);
    const projRow = await pool.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
      [projRow.rows[0].workspace_id, userRow.rows[0].id],
    );
  } finally {
    await pool.end();
  }
  await apiCtx.dispose();

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(viewerEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  await page.goto(`/app/projects/${projectId}/issues/${issueId}`);
  await expect(
    page.getByRole("heading", { name: "Async dashboard rejection" }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText("read-only access", { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("Change issue status")).toHaveCount(0);
  await expect(page.getByLabel("Assign issue")).toHaveCount(0);
  await expect(page.getByLabel("Add a comment")).toHaveCount(0);

  const cookies = await apiCookies(viewerEmail);
  const viewerCtx = await request.newContext({ baseURL: API });
  try {
    const forbidden = await viewerCtx.patch(
      `/api/v1/issues/${issueId}/status`,
      { headers: { cookie: cookies }, data: { status: "resolved" } },
    );
    expect(forbidden.status()).toBe(403);
  } finally {
    await viewerCtx.dispose();
  }
});

test("E2E-B6-4 hostile telemetry stays inert, headers present", async ({
  page,
}) => {
  await resetE2EDatabase();
  const email = uniqueEmail("xss");
  const violations: string[] = [];
  page.on("dialog", (dialog) => {
    violations.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("pageerror", (error) => {
    violations.push(`pageerror: ${error.message}`);
  });
  await registerViaUI(page, email, "Xss");
  const projectId = await onboardProject(page, "Xss WS", "xss-proj");
  const { issueId } = await publishIssue(projectId, "d", "ignored", {
    hostile: true,
  });

  const response = await page.goto(
    `/app/projects/${projectId}/issues/${issueId}`,
  );
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByText(/Raw stack trace/)).toBeVisible({
    timeout: 15_000,
  });
  // Hostile strings render as visible text, never as elements/handlers.
  await expect(page.getByText("Boom", { exact: false }).first()).toBeVisible();
  const fired = await page.evaluate(
    () => (window as unknown as { __xss?: number }).__xss,
  );
  expect(fired).toBeUndefined();
  expect(
    await page.evaluate(() => document.querySelector("script[src='x']")),
  ).toBeNull();
  expect(violations).toEqual([]);
});

test("E2E-B6-5 responsive layout and keyboard search flow", async ({
  page,
}) => {
  await resetE2EDatabase();
  await page.setViewportSize({ width: 375, height: 812 });
  const email = uniqueEmail("a11y");
  await registerViaUI(page, email, "A11y");
  const projectId = await onboardProject(page, "A11y WS", "a11y-proj");
  await publishIssue(projectId, "e", "Checkout null-product failure");
  await publishIssue(projectId, "f", "Profile save 500");

  await page.goto(`/app/projects/${projectId}/issues`);
  await expect(page.getByText("Checkout null-product failure")).toBeVisible({
    timeout: 15_000,
  });
  // Mobile drawer navigation reaches the list.
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // Keyboard-only search filters the list (debounced).
  await page.getByLabel("Search issues").click();
  await page.keyboard.type("profile", { delay: 20 });
  await expect(page.getByText("Profile save 500")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Checkout null-product failure")).toHaveCount(0, {
    timeout: 15_000,
  });
  // Status is text, not color alone (badge inside the first list row).
  await expect(
    page.locator("ul li a").first().getByText("Open", { exact: true }),
  ).toBeVisible();
});
