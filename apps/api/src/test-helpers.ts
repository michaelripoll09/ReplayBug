import { randomUUID } from "node:crypto";
import { createDbClient, type DbClient } from "@replaybug/db";
import {
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  PREFLIGHT_MAX_ENTRIES,
  UPLOAD_AGGREGATE_MAX_BYTES,
} from "@replaybug/artifacts";
import type { ApiConfig } from "./config.js";

/** Test database URL: real PG only, never SQLite. */
export function testDatabaseUrl(): string {
  return (
    process.env["REPLAYBUG_DATABASE_URL"] ??
    "postgres://replaybug:replaybug@localhost:5544/replaybug"
  );
}

export function testApiConfig(overrides?: Partial<ApiConfig>): ApiConfig {
  return {
    port: 4001,
    host: "127.0.0.1",
    nodeEnv: "test",
    environment: "test",
    version: "0.1.0",
    databaseUrl: testDatabaseUrl(),
    logLevel: "silent",
    authSecret: "test-secret-0123456789abcdef0123456789",
    webUrl: "http://localhost:3000",
    apiUrl: "http://localhost:4001",
    trustedOrigins: ["http://localhost:3000"],
    ingestMaxBatchEvents: 50,
    ingestMaxBodyBytes: 512 * 1024,
    ingestMaxEventBytes: 128 * 1024,
    ingestRateLimitRequestsPerMinute: 60,
    ingestRateLimitEventsPerMinute: 1000,
    userHmacSecret: "test-hmac-secret-0123456789abcdef0123456789",
    artifactMaxFileBytes: DEFAULT_ARTIFACT_MAX_FILE_BYTES,
    artifactPreflightMaxEntries: PREFLIGHT_MAX_ENTRIES,
    artifactAggregateMaxBytes: UPLOAD_AGGREGATE_MAX_BYTES,
    aiAnalysis: { status: "disabled", configured: false },
    ...overrides,
  };
}

export function createTestDbClient(): DbClient {
  return createDbClient({
    databaseUrl: testDatabaseUrl(),
    maxConnections: 5,
    connectionTimeoutMs: 5000,
  });
}

/** Truncate all domain + auth + telemetry tables. FK-safe via CASCADE. */
export async function resetTestDatabase(client: DbClient): Promise<void> {
  await client.pool.query(`
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
}

/** Insert a user row directly (service-level tests; no password hashing). */
export async function createTestUserRow(
  client: DbClient,
  overrides?: { email?: string; name?: string },
): Promise<{ id: string; email: string; name: string }> {
  const id = randomUUID();
  const email = overrides?.email ?? `user-${id.slice(0, 8)}@example.com`;
  const name = overrides?.name ?? "Test User";
  await client.pool.query(
    `INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
     VALUES ($1, $2, $3, false, now(), now())`,
    [id, name, email],
  );
  return { id, email, name };
}

/** Register via Better Auth email/password and return session cookies. */
export async function registerViaAuth(
  app: {
    inject: (opts: unknown) => Promise<{
      headers: Record<string, unknown>;
      statusCode: number;
      json: () => unknown;
    }>;
  },
  email: string,
  password: string,
  name = "Test User",
): Promise<{ cookies: string[]; userId: string }> {
  // Minimal structural inject; real Fastify instance in tests.
  const res = await (
    app as unknown as {
      inject: (o: {
        method: string;
        url: string;
        payload: unknown;
      }) => Promise<{
        statusCode: number;
        headers: Record<string, unknown>;
        json: () => { user?: { id?: string } };
      }>;
    }
  ).inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password, name },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(
      `sign-up failed: ${res.statusCode} ${JSON.stringify(res.json())}`,
    );
  }
  const raw = res.headers["set-cookie"];
  const cookies: string[] = Array.isArray(raw)
    ? (raw as string[])
    : raw !== undefined
      ? [String(raw)]
      : [];
  const body = res.json() as { user?: { id?: string } };
  const userId = body.user?.id ?? "";
  return { cookies, userId };
}

export function cookiesHeader(cookies: string[]): string {
  return cookies.map((c) => c.split(";")[0]).join("; ");
}
