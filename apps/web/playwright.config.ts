import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E (Chromium, CI).
 * - Isolated test DB via global setup truncation (same PG, clean tables).
 * - Reproducible: no personal data, synthetic example.com users only.
 * - Requires built API + Web (`pnpm build` first); webServer starts both.
 * - Artifact blobs live under a temp-dir root shared by the API and any
 *   worker the specs spawn (RS-12 full source-map flow), so E2E never
 *   touches the developer default (`~/.replaybug/artifacts`).
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
      // Never reuse a developer `pnpm dev` server: a stale dev API runs
      // with NODE_ENV=development (Better Auth sign-up rate limiting ON)
      // and a divergent artifact root, which silently poisons E2E with
      // register 429 stalls and worker storage_unavailable mismatches.
      // Playwright always spawns a fresh NODE_ENV=test server instead and
      // fails fast when the port is occupied.
      reuseExistingServer: false,
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
        // RS-12 temp-dir artifact root (specs compute the same default, so
        // a spawned worker shares it with this API server).
        REPLAYBUG_ARTIFACT_DIR:
          process.env["REPLAYBUG_ARTIFACT_DIR"] ??
          join(tmpdir(), "replaybug-web-e2e-artifacts"),
        // Block 10 optional local AI analysis. The API only *reports*
        // capability and persists requests — it never contacts a provider —
        // so this URL is a never-dialed placeholder; the e2e/ai-analysis
        // worker receives its own ephemeral mock-Ollama URL. The model name
        // is real configuration and must match E2E_OLLAMA_MODEL in
        // e2e/ai-analysis.spec.ts.
        REPLAYBUG_OLLAMA_URL:
          process.env["REPLAYBUG_OLLAMA_URL"] ?? "http://127.0.0.1:45999",
        REPLAYBUG_OLLAMA_MODEL:
          process.env["REPLAYBUG_OLLAMA_MODEL"] ?? "e2e-mock-ollama",
        REPLAYBUG_OLLAMA_TIMEOUT_MS:
          process.env["REPLAYBUG_OLLAMA_TIMEOUT_MS"] ?? "15000",
        LOG_LEVEL: "silent",
      },
    },
    {
      command: "pnpm --filter @replaybug/web start",
      port: 3000,
      // Same hermetic rule as the API entry above: never attach to a
      // developer `next dev` instance serving stale build output.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NEXT_PUBLIC_REPLAYBUG_API_URL: "http://localhost:4001",
      },
    },
  ],
});
