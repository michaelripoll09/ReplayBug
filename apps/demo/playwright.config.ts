import { defineConfig, devices } from "@playwright/test";
import { e2eWebServers } from "./playwright.shared";

/**
 * Block 4 telemetry E2E (Chromium) against real PostgreSQL.
 *
 * Covers the ingest/privacy pipeline with the worker intentionally NOT
 * running: accepted events stay pending and undispatched, which is the
 * durable-storage guarantee ingest must provide on its own.
 *
 * Requires:
 * - `pnpm build` first (API dist + SDK dist are consumed by the servers).
 * - e2e/seed.mjs run before Playwright (wired in the test:e2e script); it
 *   seeds the project/key/origin fixture and writes .e2e/dsn.json.
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
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: e2eWebServers(),
});
