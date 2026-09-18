import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E (Chromium, CI).
 * - Isolated test DB via global setup truncation (same PG, clean tables).
 * - Reproducible: no personal data, synthetic example.com users only.
 * - Requires built API + Web (`pnpm build` first); webServer starts both.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] !== undefined ? 1 : 0,
  reporter:
    process.env["CI"] !== undefined
      ? [["list"], ["html", { open: "never" }]]
      : "list",
  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @replaybug/api start",
      port: 4001,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        REPLAYBUG_DATABASE_URL:
          process.env["REPLAYBUG_DATABASE_URL"] ??
          "postgres://replaybug:replaybug@localhost:5544/replaybug",
        REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
        REPLAYBUG_WEB_URL: "http://localhost:3000",
        REPLAYBUG_API_URL: "http://localhost:4001",
        REPLAYBUG_TRUSTED_ORIGINS: "http://localhost:3000",
        REPLAYBUG_USER_HMAC_SECRET:
          "test-hmac-secret-0123456789abcdef0123456789",
        LOG_LEVEL: "silent",
      },
    },
    {
      command: "pnpm --filter @replaybug/web start",
      port: 3000,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        NEXT_PUBLIC_REPLAYBUG_API_URL: "http://localhost:4001",
      },
    },
  ],
});
