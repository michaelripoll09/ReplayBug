import { test, expect, request } from "@playwright/test";
import { Pool } from "pg";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * E2E3: RBAC — owner sees management controls, viewer is read-only,
 * and a direct HTTP mutation as viewer is still forbidden (403).
 */
test("E2E3 RBAC owner vs viewer", async ({ page }) => {
  await resetE2EDatabase();
  const ownerEmail = uniqueEmail("owner");
  const viewerEmail = uniqueEmail("viewer");

  // Owner: register + workspace + project via UI.
  await page.goto("/register");
  await page.getByLabel("Name").fill("Owner");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });
  await page.getByLabel("Workspace name").fill("RBAC WS");
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });
  await page.getByLabel("Project name").fill("rbac-proj");
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

  // Owner sees management controls in settings.
  await page.goto(`/app/projects/${projectId}/settings`);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("tab", { name: "Public Key" }).click();
  await expect(
    page.getByRole("button", { name: "Rotate public key…" }),
  ).toBeVisible();

  // Create viewer user via API, grant viewer membership directly in DB.
  const apiCtx = await request.newContext({ baseURL: "http://localhost:4001" });
  const signup = await apiCtx.post("/api/auth/sign-up/email", {
    data: { email: viewerEmail, password: E2E_PASSWORD, name: "Viewer" },
  });
  expect(signup.ok()).toBeTruthy();
  const meRes = await apiCtx.get("/api/v1/me", {
    headers: {
      cookie: (await signup.headersArray())
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value.split(";")[0])
        .join("; "),
    },
  });
  void meRes;
  // Resolve viewer user id + workspace id via DB, insert viewer membership.
  const pool = new Pool({
    connectionString:
      process.env["REPLAYBUG_DATABASE_URL"] ??
      "postgres://replaybug:replaybug@localhost:5544/replaybug",
  });
  try {
    const userRow = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      viewerEmail,
    ]);
    const viewerId: string = userRow.rows[0].id;
    // Workspace id is the project’s workspace: look it up from the project.
    const projRow = await pool.query(
      `SELECT workspace_id FROM projects WHERE id = $1`,
      [projectId],
    );
    const wsId: string = projRow.rows[0].workspace_id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'viewer') ON CONFLICT DO NOTHING`,
      [wsId, viewerId],
    );
  } finally {
    await pool.end();
  }
  await apiCtx.dispose();

  // Viewer: login via UI, read-only (no save/rotate).
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(viewerEmail);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goto(`/app/projects/${projectId}/settings`);
  await expect(page.getByText("Read-only").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "Public Key" }).click();
  await expect(
    page.getByRole("button", { name: "Rotate public key…" }),
  ).toHaveCount(0);

  // Direct HTTP mutation as viewer is still forbidden (backend authority).
  const viewerCtx = await request.newContext({
    baseURL: "http://localhost:4001",
  });
  const signin = await viewerCtx.post("/api/auth/sign-in/email", {
    data: { email: viewerEmail, password: E2E_PASSWORD },
  });
  expect(signin.ok()).toBeTruthy();
  const cookies = (await signin.headersArray())
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0])
    .join("; ");
  const forbidden = await viewerCtx.post(
    `/api/v1/projects/${projectId}/keys/public/rotate`,
    {
      headers: { cookie: cookies },
    },
  );
  expect(forbidden.status()).toBe(403);
  await viewerCtx.dispose();
});
