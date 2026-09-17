import { Pool } from "pg";

/** Truncate all domain + auth tables for isolated E2E. No personal data persists. */
export async function resetE2EDatabase(): Promise<void> {
  const url =
    process.env["REPLAYBUG_DATABASE_URL"] ??
    "postgres://replaybug:replaybug@localhost:5544/replaybug";
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`
      TRUNCATE "user", "session", "account", "verification",
        "audit_logs", "project_keys", "project_origins",
        "project_environments", "projects",
        "workspace_memberships", "workspaces"
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await pool.end();
  }
}

export function uniqueEmail(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}@example.com`;
}

export const E2E_PASSWORD = "TestPass123!";
