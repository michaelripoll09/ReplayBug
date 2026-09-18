import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration suites share one PostgreSQL database and reset fixtures, so
    // files must not run concurrently.
    fileParallelism: false,
  },
});
