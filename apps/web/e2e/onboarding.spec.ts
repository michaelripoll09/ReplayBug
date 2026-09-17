import { test, expect } from "@playwright/test";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/**
 * E2E1: register -> onboarding (workspace, project, one-time key, origin,
 * complete, overview, logout -> login redirect).
 * The one-time key format is asserted WITHOUT logging it.
 */
test("E2E1 register → onboarding → overview → logout", async ({ page }) => {
  await resetE2EDatabase();
  const email = uniqueEmail("e2e1");

  // Register (no auto-workspace).
  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });

  // Workspace step.
  await page.getByLabel("Workspace name").fill("E2E Workspace");
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project\?workspaceId=/, {
    timeout: 15_000,
  });

  // Project step.
  await page.getByLabel("Project name").fill("e2e-project");
  await page.getByRole("button", { name: "Create project" }).click();
  // One-time key appears once; assert format without logging the value.
  const keyCode = page.locator("code").first();
  await expect(keyCode).toBeVisible({ timeout: 15_000 });
  const keyText = (await keyCode.textContent()) ?? "";
  // Reveal first: hidden by default (dots). Click reveal, then assert format.
  await page.getByRole("button", { name: "Reveal secret" }).click();
  const revealed = (await keyCode.textContent()) ?? "";
  expect(revealed).toMatch(/^rb_pk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  expect(keyText).not.toEqual(revealed);
  await page
    .getByRole("button", { name: "I copied the key — continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/origin\?projectId=/, {
    timeout: 15_000,
  });

  // Origin step (explicit consent, dev suggestion).
  await page.getByRole("button", { name: "http://localhost:3000" }).click();
  await page.getByRole("button", { name: "Add origin and finish" }).click();
  await expect(page).toHaveURL(/\/onboarding\/complete\?projectId=/, {
    timeout: 15_000,
  });

  // Complete screen + Go to project.
  await expect(page.getByText("You are set up")).toBeVisible();
  await page.getByRole("button", { name: "Go to project" }).click();
  await expect(page).toHaveURL(/\/app\/projects\//, { timeout: 15_000 });
  await expect(page.getByText("Telemetry not configured yet")).toBeVisible();

  // Logout -> protected blocked -> login redirect.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
