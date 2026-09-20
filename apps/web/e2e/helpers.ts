import { Pool } from "pg";

/** Truncate all application tables for isolated E2E. No personal data persists. */
export async function resetE2EDatabase(): Promise<void> {
  const url =
    process.env["REPLAYBUG_DATABASE_URL"] ??
    "postgres://replaybug:replaybug@localhost:5544/replaybug";
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`
      TRUNCATE "user", "session", "account", "verification",
        "audit_logs", "event_processing_outbox", "artifact_deletion_outbox",
        "events", "rate_limit_buckets",
        "telemetry_sessions", "project_keys", "project_origins",
        "project_environments", "projects",
        "issue_comments", "issue_tag_assignments", "issue_tags",
        "issue_activity", "issue_affected_sessions", "issues", "notifications",
        "release_artifacts", "releases",
        "reproduction_generation_outbox", "reproduction_tests",
        "workspace_invitations", "workspace_memberships", "workspaces"
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
