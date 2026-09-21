import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/observability/vitest.config.ts",
  "packages/contracts/vitest.config.ts",
  "packages/db/vitest.config.ts",
  "packages/sdk/vitest.config.ts",
  "packages/cli/vitest.config.ts",
  "packages/api-client/vitest.config.ts",
  "packages/artifacts/vitest.config.ts",
  "packages/ui/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/worker/vitest.config.ts",
]);
