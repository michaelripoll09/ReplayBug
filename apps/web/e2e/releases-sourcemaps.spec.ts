import { test, expect, request, type Page } from "@playwright/test";
import { Pool } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * RS-10 dashboard E2E on the real stack (API + Web + PostgreSQL):
 * releases list/detail, secret-token settings flow (one-time reveal,
 * no plaintext persistence), and the source-mapped stack toggle.
 *
 * Release/artifact rows are seeded directly (the CLI upload path is covered
 * by RS-07/RS-12 suites); worker symbolication enrichment is simulated at
 * the persisted-JSON boundary the same way Block 6 specs simulate worker
 * completion (rows written, UI reads them).
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
  // The shared dev API enforces a tight sign-up burst budget (429s) while
  // fresh NODE_ENV=test servers disable rate limiting entirely. Retry once
  // after the window slides so this spec stays green in both environments.
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

/** API sign-up with the same 429 tolerance as registerViaUI. */
async function signupViaApi(email: string): Promise<boolean> {
  const ctx = await request.newContext({ baseURL: API });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await ctx.post("/api/auth/sign-up/email", {
        data: { email, password: E2E_PASSWORD, name: "Member" },
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

async function seedRelease(
  projectId: string,
  version: string,
  opts: {
    commitSha?: string;
    withMaps?: boolean;
    occurrences?: number;
  } = {},
): Promise<string> {
  const pool = db();
  try {
    const releaseRow = await pool.query(
      `INSERT INTO releases (project_id, version, commit_sha, repository_url)
       VALUES ($1, $2, $3, 'https://github.com/acme/app')
       RETURNING id`,
      [projectId, version, opts.commitSha ?? null],
    );
    const releaseId = releaseRow.rows[0].id as string;
    if (opts.withMaps === true) {
      await pool.query(
        `INSERT INTO release_artifacts
           (release_id, artifact_path, storage_key, content_hash,
            size_bytes, artifact_type)
         VALUES ($1, 'assets/app.js.map', 'seed-map-key', $2, 1024,
                 'source_map'),
                ($1, 'assets/app.js', 'seed-js-key', $3, 2048,
                 'minified_asset')`,
        [releaseId, "a".repeat(64), "b".repeat(64)],
      );
    }
    const occurrences = opts.occurrences ?? 0;
    if (occurrences > 0) {
      const sessionId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO telemetry_sessions
           ("id", "project_id", "sdk_session_id", "environment",
            "initial_url", "sdk_version")
         VALUES ($1, $2, $3, 'production', 'https://example.com/', 't@0')`,
        [sessionId, projectId, `sdk-${releaseId.slice(0, 8)}`],
      );
      for (let i = 0; i < occurrences; i += 1) {
        await pool.query(
          `INSERT INTO events
             ("project_id", "telemetry_session_id", "client_event_id",
              "sequence_number", "event_type", "occurred_at",
              "environment", "release", "payload_json", "processing_state")
           VALUES ($1, $2, $3, $4, 'message', now(),
                   'production', $5, '{"message": "hi", "level": "info"}',
                   'processed')`,
          [projectId, sessionId, crypto.randomUUID(), i + 1, version],
        );
      }
    }
    return releaseId;
  } finally {
    await pool.end();
  }
}

/** Seed an issue whose event carries persisted symbolication enrichment. */
async function seedStackIssue(
  projectId: string,
  fingerprintChar: string,
  release: string,
  symbolication: Record<string, unknown> | null,
): Promise<string> {
  const pool = db();
  try {
    await pool.query(
      `INSERT INTO releases (project_id, version)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [projectId, release],
    );
    const issueId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, $3, 'sig', 'exception', $4, $4, 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectId, fingerprintChar.repeat(64), `Stack ${release}`],
    );
    await pool.query(
      `INSERT INTO telemetry_sessions
         ("id", "project_id", "sdk_session_id", "environment",
          "initial_url", "sdk_version")
       VALUES ($1, $2, $3, 'production', 'https://example.com/', 't@0')`,
      [sessionId, projectId, `sdk-${issueId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO events
         ("id", "project_id", "telemetry_session_id", "client_event_id",
          "sequence_number", "event_type", "occurred_at",
          "environment", "release", "page_url", "payload_json",
          "symbolication_json", "issue_id", "processing_state")
       VALUES ($1, $2, $3, $4, 1, 'exception', now(),
               'production', $5, 'https://example.com/',
               '{"values": [{"type": "TypeError", "value": "boom",
                 "stacktrace": {"frames": [
                   {"filename": "https://example.com/assets/app.js",
                    "function": "a", "lineno": 1, "colno": 11,
                    "in_app": true}]}}]}',
               $6, $7, 'processed')`,
      [
        eventId,
        projectId,
        sessionId,
        crypto.randomUUID(),
        release,
        symbolication === null ? null : JSON.stringify(symbolication),
        issueId,
      ],
    );
    return issueId;
  } finally {
    await pool.end();
  }
}

const MAPPED_SYMBOLICATION = {
  status: "mapped",
  rawFrames: [
    {
      filename: "https://example.com/assets/app.js",
      function: "a",
      lineno: 1,
      colno: 11,
      inApp: true,
    },
  ],
  mappedFrames: [
    {
      filename: "https://example.com/assets/app.js",
      source: "src/checkout.ts",
      function: "a",
      name: "handleCheckout",
      line: 42,
      column: 7,
      inApplication: true,
      mapped: true,
    },
  ],
  mappedFrameCount: 1,
};

test("E2E-RS10-1 releases list and detail render counts and metadata", async ({
  page,
}) => {
  await resetE2EDatabase();
  const email = uniqueEmail("releases");
  await registerViaUI(page, email, "Releases");
  const projectId = await onboardProject(page, "Rel WS", "rel-proj");
  const releaseId = await seedRelease(projectId, "web@7.2.1", {
    commitSha: "abc1234def5678",
    withMaps: true,
    occurrences: 3,
  });
  await seedRelease(projectId, "web@7.2.0", { occurrences: 1 });

  await page.goto(`/app/projects/${projectId}/releases`);
  await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("web@7.2.1")).toBeVisible();
  await expect(page.getByText("abc1234")).toBeVisible();
  await expect(page.getByText("1 mapped")).toBeVisible();
  await expect(page.getByText("No maps")).toBeVisible();
  // Project navigation gained a Releases entry.
  await expect(
    page
      .getByRole("navigation", { name: "Project sections" })
      .getByText("Releases"),
  ).toBeVisible();

  await page.getByRole("link", { name: "web@7.2.1" }).click();
  await expect(page).toHaveURL(new RegExp(`/releases/${releaseId}`), {
    timeout: 15_000,
  });
  await expect(page.getByText("assets/app.js.map")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Source map", { exact: true })).toBeVisible();
  await expect(page.getByText("Minified asset", { exact: true })).toBeVisible();
  await expect(page.getByText("Stored").first()).toBeVisible();
  await expect(page.getByText("3 occurrences")).toBeVisible();
});

test("E2E-RS10-2 secret-token settings: one-time reveal, clean close, revoke", async ({
  page,
}) => {
  await resetE2EDatabase();
  const email = uniqueEmail("tokens");
  await registerViaUI(page, email, "Tokens");
  const projectId = await onboardProject(page, "Tok WS", "tok-proj");

  await page.goto(`/app/projects/${projectId}/settings/keys`);
  await expect(
    page.getByRole("heading", { name: "Public ingest key" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "Secret project tokens" }),
  ).toBeVisible();
  await expect(page.getByText("browser-safe, write-only")).toBeVisible();
  await expect(
    page.getByText("CLI/CI-only credentials. Never use them in frontend code."),
  ).toBeVisible();

  await page.getByLabel("Token name").fill("ci-e2e");
  await page.getByRole("button", { name: "Create secret token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("shown once")).toBeVisible({ timeout: 15_000 });
  const tokenText = (await dialog.locator("code").textContent()) ?? "";
  expect(tokenText).toMatch(/^rb_sk_[0-9a-f]{8}_/);
  await expect(dialog.getByText("REPLAYBUG_AUTH_TOKEN")).toBeVisible();
  // Usage hint only — never a giant committable shell command.
  expect(await dialog.textContent()).not.toContain("&&");
  await expect(dialog.getByRole("button", { name: "Copy" })).toBeVisible();

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText(tokenText)).toHaveCount(0, { timeout: 15_000 });

  // Plaintext never persisted: storage, URL, or history.
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

  await page.getByRole("button", { name: "Revoke token ci-e2e" }).click();
  await expect(page.getByText("Revoked")).toBeVisible({ timeout: 15_000 });
});

test("E2E-RS10-3 member sees a graceful secret-token notice, viewer stack raw", async ({
  page,
}) => {
  // May sleep through one sign-up rate-limit window on shared dev servers.
  test.setTimeout(240_000);
  await resetE2EDatabase();
  const ownerEmail = uniqueEmail("tokowner");
  const memberEmail = uniqueEmail("tokmember");
  await registerViaUI(page, ownerEmail, "Owner");
  const projectId = await onboardProject(page, "Tok WS", "tok-proj");

  expect(await signupViaApi(memberEmail)).toBeTruthy();
  const pool = db();
  try {
    const userRow = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      memberEmail,
    ]);
    const projRow = await pool.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [projRow.rows[0].workspace_id, userRow.rows[0].id],
    );
  } finally {
    await pool.end();
  }

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(memberEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });

  await page.goto(`/app/projects/${projectId}/settings/keys`);
  await expect(page.getByText("restricted")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Token name")).toHaveCount(0);

  // Members may still read releases.
  const releaseId = await seedRelease(projectId, "web@7.3.0", {
    withMaps: true,
  });
  await page.goto(`/app/projects/${projectId}/releases`);
  await expect(page.getByText("web@7.3.0")).toBeVisible({ timeout: 15_000 });
  await page.goto(`/app/projects/${projectId}/releases/${releaseId}`);
  await expect(page.getByText("assets/app.js.map")).toBeVisible({
    timeout: 15_000,
  });
});

test("E2E-RS10-4 mapped stack by default with Raw toggle, honest no-map state", async ({
  page,
}) => {
  // May sleep through one sign-up rate-limit window on shared dev servers.
  test.setTimeout(240_000);
  await resetE2EDatabase();
  const email = uniqueEmail("stack");
  await registerViaUI(page, email, "Stack");
  const projectId = await onboardProject(page, "Stack WS", "stack-proj");

  const mappedIssue = await seedStackIssue(
    projectId,
    "a",
    "web@9.0.0",
    MAPPED_SYMBOLICATION,
  );
  const unmappedIssue = await seedStackIssue(projectId, "b", "web@9.0.1", {
    status: "release_not_found",
    rawFrames: [
      {
        filename: "https://example.com/assets/app.js",
        function: "a",
        lineno: 1,
        colno: 11,
        inApp: true,
      },
    ],
    mappedFrames: [],
    mappedFrameCount: 0,
  });

  await page.goto(`/app/projects/${projectId}/issues/${mappedIssue}`);
  await expect(page.getByRole("button", { name: "Source mapped" })).toBeVisible(
    { timeout: 15_000 },
  );
  await expect(
    page.getByRole("button", { name: "Source mapped" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("src/checkout.ts:42:7 handleCheckout()"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Raw" }).click();
  await expect(
    page.getByText("https://example.com/assets/app.js:1:11"),
  ).toBeVisible();

  await page.goto(`/app/projects/${projectId}/issues/${unmappedIssue}`);
  await expect(page.getByText(/Raw stack trace/)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/release not registered/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Source mapped" })).toHaveCount(
    0,
  );
});
