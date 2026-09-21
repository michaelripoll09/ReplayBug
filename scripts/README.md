# Scripts

Operational Node scripts live here and are designed to remain cross-platform,
including Windows PowerShell 5.1. They are invoked through the root `pnpm`
scripts where one exists.

## Available scripts

| File                                     | Command                      | Purpose                                                                                   |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `seed-dev.ts`                            | `pnpm db:seed`               | Creates development demo tenancy data; it is not production provisioning.                 |
| `sdk-size.mjs`                           | `pnpm sdk:size`              | Checks the SDK bundle-size budget.                                                        |
| `worker-latency-smoke.ts`                | `pnpm worker:latency`        | Runs the documented local processing-latency smoke after build with PostgreSQL available. |
| `verify-generated-test.ts`               | `pnpm verify:generated-test` | Validates and executes a generated Playwright test only against a loopback target.        |
| `test-parallel-integration-isolation.ts` | `pnpm test:isolation`        | Exercises isolated integration-test database behavior.                                    |
| `run-isolated-vitest.ts`                 | internal helper              | Runs the isolated Vitest workflow used by repository test tooling.                        |

These scripts do not provide SMTP delivery, S3 operations, deployment
automation, arbitrary remote test execution, or production migration
orchestration. Use the documented repository quality commands in the root
README for standard format, lint, typecheck, test, API drift, build, and E2E
checks.
