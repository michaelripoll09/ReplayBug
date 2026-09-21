import { defineConfig, devices } from "@playwright/test";

/**
 * Focused SDK/demo browser-engine smoke. It deliberately runs only the
 * compatibility spec and serves the Vite demo locally, without API or DB
 * processes. An empty DSN prevents telemetry from leaving the local host.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "browser-compatibility.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] !== undefined ? 1 : 0,
  reporter: process.env["CI"] !== undefined ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command:
      "pnpm --filter @replaybug/demo exec vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      VITE_REPLAYBUG_DSN: "",
    },
  },
});
