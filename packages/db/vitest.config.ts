import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Parallel-load teardown: pool.end() + DROP DATABASE under turbo-parallel runs needs headroom beyond the 10s default.
    hookTimeout: 30000,
  },
});
