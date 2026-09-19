import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each package test run owns an isolated PostgreSQL database; files still
    // serialize because their fixtures truncate that package-owned database.
    fileParallelism: false,
  },
});
