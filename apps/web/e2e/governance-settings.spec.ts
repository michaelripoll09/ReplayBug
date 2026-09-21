import { test, expect, request, type Page } from "@playwright/test";
import { Pool } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

const API = "http://localhost:4001";
const DB_URL =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

/**
 * Governance prerequisites are explicit: Playwright must start the test API,
 * web app, and PostgreSQL fixture from playwright.config.ts. The test uses
 * the same direct membership setup as the existing RBAC E2E because the UI
 * invitation acceptance flow is outside this settings-surface check.
 */
async function registerAndOnboard(page: Page, email: string): Promise<string> {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Governance owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });
  await page.getByLabel("Workspace name").fill("Governance WS");
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });
  await page.getByLabel("Project name").fill("governance-project");
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

async function workspaceDetails(
  projectId: string,
): Promise<{ id: string; slug: string }> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    const result = await pool.query(
      `SELECT w.id, w.slug
       FROM workspaces w
       JOIN projects p ON p.workspace_id = w.id
       WHERE p.id = $1`,
      [projectId],
    );
    const row = result.rows[0] as { id?: unknown; slug?: unknown } | undefined;
    if (typeof row?.id !== "string" || typeof row.slug !== "string") {
      throw new Error("workspace fixture was not created");
    }
    return { id: row.id, slug: row.slug };
  } finally {
    await pool.end();
  }
}

async function createViewerMembership(
  projectId: string,
  email: string,
): Promise<void> {
  const apiContext = await request.newContext({ baseURL: API });
  const signup = await apiContext.post("/api/auth/sign-up/email", {
    data: { email, password: E2E_PASSWORD, name: "Governance viewer" },
  });
  expect(signup.ok()).toBeTruthy();
  await apiContext.dispose();

  const pool = new Pool({ connectionString: DB_URL });
  try {
    const userResult = await pool.query(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    const projectResult = await pool.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    const userId = userResult.rows[0]?.id as string | undefined;
    const workspaceId = projectResult.rows[0]?.workspace_id as
      string | undefined;
    if (userId === undefined || workspaceId === undefined) {
      throw new Error("viewer membership fixture was not created");
    }
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'viewer')
       ON CONFLICT DO NOTHING`,
      [workspaceId, userId],
    );
  } finally {
    await pool.end();
  }
}

test("governance settings keep destructive confirmation and one-time reveal safe", async ({
  page,
}) => {
  await resetE2EDatabase();
  const ownerEmail = uniqueEmail("governance-owner");
  const viewerEmail = uniqueEmail("governance-viewer");
  const projectId = await registerAndOnboard(page, ownerEmail);
  const workspace = await workspaceDetails(projectId);
  await createViewerMembership(projectId, viewerEmail);

  await page.goto(`/app/workspaces/${workspace.id}/settings`);
  await expect(
    page.getByRole("heading", { name: "Workspace settings" }),
  ).toBeVisible({ timeout: 15_000 });
  for (const tab of ["Members", "Audit Log", "Danger Zone", "General"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/app/workspaces/${workspace.id}/settings`),
    );
  }

  await page.getByRole("tab", { name: "Danger Zone", exact: true }).click();
  await page.getByRole("button", { name: "Delete workspace…" }).click();
  const workspaceConfirmation = page.getByLabel("Workspace slug");
  const deleteWorkspace = page.getByRole("button", {
    name: "Delete workspace",
    exact: true,
  });
  await workspaceConfirmation.fill("Governance WS");
  await expect(deleteWorkspace).toBeDisabled();
  await workspaceConfirmation.fill(workspace.slug);
  await expect(deleteWorkspace).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("tab", { name: "Invitations", exact: true }).click();
  await page.getByLabel("Invite email").fill(uniqueEmail("revealed"));
  await page.getByRole("button", { name: "Create invitation" }).click();
  const token = page.locator("#one-time-invitation-token");
  await expect(token).toBeVisible({ timeout: 15_000 });
  const tokenText = (await token.textContent())?.trim() ?? "";
  expect(tokenText.length).toBeGreaterThan(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:3000",
  });
  await page.getByRole("button", { name: "Copy token" }).click();
  await expect(page.getByRole("button", { name: "Token copied" })).toBeVisible({
    timeout: 5_000,
  });
  expect(page.url()).not.toContain(tokenText);
  await page.getByRole("button", { name: "Close and clear" }).click();
  await expect(token).toHaveCount(0);
  expect(page.url()).not.toContain(tokenText);

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(viewerEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
  await page.goto(`/app/workspaces/${workspace.id}/settings`);
  await expect(page.getByText("Read-only workspace settings")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );

  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await expect(page.getByText("Read-only members list")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: /Change role for/ }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Invitations", exact: true }).click();
  await expect(page.getByText("Invitations are restricted")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create invitation" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Audit Log", exact: true }).click();
  await expect(page.getByText("Audit log is restricted")).toBeVisible();
  await page.getByRole("tab", { name: "Danger Zone", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete workspace…" }),
  ).toHaveCount(0);
});
