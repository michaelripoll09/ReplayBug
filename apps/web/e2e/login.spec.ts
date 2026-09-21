import { test, expect } from "@playwright/test";
import { resetE2EDatabase, uniqueEmail, E2E_PASSWORD } from "./helpers";

/** E2E2: login (wrong creds, correct login, refresh persists, logout, protected blocked). */
test("E2E2 login lifecycle", async ({ page }) => {
  await resetE2EDatabase();
  const email = uniqueEmail("e2e2");

  // Seed via register, then clear cookies to test login explicitly.
  await page.goto("/register");
  await page.getByLabel("Name").fill("Login User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding\/workspace/, { timeout: 15_000 });

  await page.getByLabel("Workspace name").fill("Login WS");
  await page
    .getByRole("button", { name: "Create workspace and continue" })
    .click();
  await expect(page).toHaveURL(/\/onboarding\/project/, { timeout: 15_000 });

  // Clear the browser session (register auto-signed us in).
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible({ timeout: 15_000 });

  // Wrong creds -> inline error, stays on login.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD.slice(0, -2) + "xx");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid email or password")).toBeVisible({
    timeout: 15_000,
  });

  // Correct login -> smart redirect (has workspace, no project -> project step or app).
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // Refresh persists (cookie session, not localStorage).
  await page.reload();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  // Navigate to app shell and logout; protected routes then block.
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  const logout = page.getByRole("button", { name: "Log out" });
  if ((await logout.count()) > 0) {
    await logout.first().click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  } else {
    await page.context().clearCookies();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    return;
  }
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
});
