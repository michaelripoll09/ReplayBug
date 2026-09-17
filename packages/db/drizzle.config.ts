import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration. No domain tables exist yet: this foundation
 * block only prepares the migration pipeline, client factory and health
 * helpers. Domain tables (workspaces, projects, events, issues, ...) will
 * be added by later blocks with forward-only migrations.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env["REPLAYBUG_DATABASE_URL"] ??
      "postgres://localhost:5432/replaybug",
  },
});
