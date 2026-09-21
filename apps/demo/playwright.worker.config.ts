import { defineConfig, devices } from "@playwright/test";
import { e2eWebServers } from "./playwright.shared";

/**
 * Block 5 worker E2E (Chromium) against real PostgreSQL.
 *
 * Runs the same API + demo stack as `playwright.config.ts`, and the worker
 * E2E specs spawn the real worker process themselves so they can prove the
 * "worker was down, accepted events waited, then drained" path and the full
 * browser → SDK → ingest → outbox → pg-boss → worker → issue pipeline.
 *
 * Requires:
 * - `pnpm build` first (API dist, worker dist and SDK dist are consumed).
 * - e2e/seed.mjs run before Playwright (wired in the test:e2e script).
 */
export default defineConfig({
  testDir: "./e2e-worker",
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
      name: "chromium-worker",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: e2eWebServers(),
});
