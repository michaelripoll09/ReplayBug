import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Shared configuration helpers for the demo Playwright suites.
 *
 * `playwright.config.ts` covers the ingest/privacy pipeline (no worker
 * running); `playwright.worker.config.ts` runs the same stack plus the real
 * worker process to prove ingest → outbox → pg-boss → worker → issue.
 *
 * Both require a prior `pnpm build` (API dist, worker dist and SDK dist are
 * consumed by the servers/processes these configs start).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadDsn(): string {
  const raw = readFileSync(join(HERE, ".e2e", "dsn.json"), "utf8");
  return (JSON.parse(raw) as { dsn: string }).dsn;
}

export const databaseUrl =
  process.env["REPLAYBUG_DATABASE_URL"] ??
  "postgres://replaybug:replaybug@localhost:5544/replaybug";

type WebServerEntries = Extract<
  NonNullable<PlaywrightTestConfig["webServer"]>,
  readonly unknown[]
>;

export function apiServer(): WebServerEntries {
  return [
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
  ];
}

export function demoServer(): WebServerEntries {
  return [
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
  ];
}

export function e2eWebServers(): WebServerEntries {
  return [...apiServer(), ...demoServer()];
}
