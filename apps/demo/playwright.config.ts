import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Block 4 telemetry E2E (Chromium) against real PostgreSQL.
 *
 * Requires:
 * - `pnpm build` first (API dist + SDK dist are consumed by the servers).
 * - e2e/seed.mjs run before Playwright (wired in the test:e2e script); it
 *   seeds the project/key/origin fixture and writes .e2e/dsn.json.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

function loadDsn(): string {
  const raw = readFileSync(join(HERE, ".e2e", "dsn.json"), "utf8");
  return (JSON.parse(raw) as { dsn: string }).dsn;
}

const databaseUrl =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

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
  webServer: [
    {
      command: "pnpm --filter @replaybug/api start",
      port: 4001,
      reuseExistingServer: process.env["CI"] === undefined,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        REPLAYBUG_DATABASE_URL: databaseUrl,
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
      command: "pnpm --filter @replaybug/demo dev",
      port: 5173,
      // The demo server must carry this run's DSN, so it is never reused.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_REPLAYBUG_DSN: loadDsn(),
        VITE_REPLAYBUG_ENVIRONMENT: "e2e",
        VITE_REPLAYBUG_RELEASE: "demo-e2e@0.1.0",
      },
    },
  ],
});
