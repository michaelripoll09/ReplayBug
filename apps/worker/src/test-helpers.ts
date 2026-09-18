import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger, type Logger } from "@replaybug/observability";
import {
  createDbClient,
  insertEvent,
  insertOutbox,
  schema,
  upsertTelemetrySession,
} from "@replaybug/db";
import type { DbClient } from "@replaybug/db";
import type { WorkerConfig } from "./config.js";

/**
 * Shared fixtures for worker integration tests. Real PostgreSQL only.
 *
 * Each integration test file creates its own temporary database, applies the
 * real migrations and drops it afterwards. That keeps the worker suites
 * isolated from the API suites (which reset the shared development database)
 * and safe to run in parallel under Turborepo.
 */

const DRIZZLE_DIR = fileURLToPath(
  new URL("../../../packages/db/drizzle", import.meta.url),
);

export function testDatabaseUrl(): string {
  return (
    process.env["REPLAYBUG_DATABASE_URL"] ??
    "postgres://replaybug:replaybug@localhost:5544/replaybug"
  );
}

export function createTestDbClient(databaseUrl = testDatabaseUrl()): DbClient {
  return createDbClient({
    databaseUrl,
    maxConnections: 10,
    connectionTimeoutMs: 5000,
  });
}

export interface WorkerTestDatabase {
  databaseUrl: string;
  client: DbClient;
  drop(): Promise<void>;
}

/** Creates an isolated database with the real migrations applied. */
export async function createWorkerTestDatabase(): Promise<WorkerTestDatabase> {
  const name = `replaybug_worker_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const client = createTestDbClient(databaseUrl);
  await migrate(drizzle(client.pool, { schema }), {
    migrationsFolder: DRIZZLE_DIR,
  });

  return {
    databaseUrl,
    client,
    async drop(): Promise<void> {
      await client.close();
      const cleanup = new Pool({ connectionString: testDatabaseUrl(), max: 1 });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export function createTestWorkerConfig(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    nodeEnv: "test",
    environment: "test",
    databaseUrl: testDatabaseUrl(),
    logLevel: "silent",
    bossSchema: `pgboss_test_${randomUUID().slice(0, 8)}`,
    concurrency: 2,
    outboxBatchSize: 100,
    outboxPollMs: 500,
    outboxReconcileMs: 60_000,
    jobRetryLimit: 2,
    jobPollMs: 500,
    ...overrides,
  };
}

export function createTestLogger(): Logger {
  return createLogger({ service: "worker-test", level: "silent" });
}

/** Polls until fn returns a non-null value or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | null> | T | null,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== null && result !== undefined) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface SeededProject {
  userId: string;
  workspaceId: string;
  projectId: string;
}

export async function seedProject(client: DbClient): Promise<SeededProject> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `worker-test-user-${suffix}`;
  const workspaceId = randomUUID();
  const projectId = randomUUID();

  await client.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, $2, $3, false, now(), now())`,
    [userId, "Worker Test User", `worker-${suffix}@example.com`],
  );
  await client.pool.query(
    `INSERT INTO workspaces (id, name, slug, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [workspaceId, "Worker Test WS", `worker-ws-${suffix}`, userId],
  );
  await client.pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [workspaceId, userId],
  );
  await client.pool.query(
    `INSERT INTO projects (id, workspace_id, name, slug)
     VALUES ($1, $2, $3, $4)`,
    [projectId, workspaceId, "Worker Test Project", `worker-proj-${suffix}`],
  );

  return { userId, workspaceId, projectId };
}

export interface TestEventInput {
  projectId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Reuse a session by passing the same sdk_session_id. */
  sdkSessionId?: string;
  occurredAt?: Date;
  release?: string | null;
  environment?: string;
  clientEventId?: string;
  createOutbox?: boolean;
}

export interface TestEventResult {
  eventId: string;
  sessionId: string;
}

export async function insertTestEvent(
  client: DbClient,
  input: TestEventInput,
): Promise<TestEventResult> {
  const sdkSessionId = input.sdkSessionId ?? `sdk-${randomUUID()}`;
  const environment = input.environment ?? "test";
  const release = input.release ?? null;
  const occurredAt = input.occurredAt ?? new Date();

  const session = await upsertTelemetrySession(client.db, {
    projectId: input.projectId,
    sdkSessionId,
    anonymousUserHash: null,
    environment,
    release,
    initialUrl: "http://localhost:5173/",
    browserName: null,
    browserVersion: null,
    osName: null,
    osVersion: null,
    deviceType: null,
    viewportWidth: null,
    viewportHeight: null,
    sdkVersion: "test-sdk@0.0.0",
  });

  const event = await insertEvent(client.db, {
    projectId: input.projectId,
    telemetrySessionId: session.id,
    clientEventId: input.clientEventId ?? randomUUID(),
    sequenceNumber: 1,
    eventType: input.eventType,
    occurredAt,
    environment,
    release,
    pageUrl: "http://localhost:5173/",
    payloadJson: input.payload,
  });
  if (event === undefined) {
    throw new Error("test fixture failed to insert event");
  }
  if (input.createOutbox !== false) {
    await insertOutbox(client.db, event.id);
  }
  return { eventId: event.id, sessionId: session.id };
}

export interface TestFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

export function exceptionPayload(
  value: string,
  options: {
    type?: string;
    frames?: TestFrame[];
    fingerprint?: string[];
    mechanismHandled?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    values: [
      {
        type: options.type ?? "TypeError",
        value,
        stacktrace:
          options.frames === undefined ? undefined : { frames: options.frames },
        mechanism: {
          type: "generic",
          handled: options.mechanismHandled ?? false,
        },
      },
    ],
    ...(options.fingerprint === undefined
      ? {}
      : { fingerprint: options.fingerprint }),
  };
}

/* ------------------------------------------------------------------ */
/* Raw row readers for assertions (tests only, never production code)  */
/* ------------------------------------------------------------------ */

export interface EventRowShape {
  id: string;
  processing_state: string;
  fingerprint: string | null;
  issue_id: string | null;
  rejection_reason: string | null;
  release: string | null;
}

export interface IssueRowShape {
  id: string;
  project_id: string;
  fingerprint: string;
  fingerprint_signature: string;
  type: string;
  title: string;
  normalized_message: string;
  status: string;
  severity: string;
  assigned_to_user_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  first_release: string | null;
  last_release: string | null;
  occurrence_count: number;
  affected_session_count: number;
}

export interface ActivityRowShape {
  id: string;
  issue_id: string;
  actor_user_id: string | null;
  type: string;
  metadata_json: Record<string, unknown>;
}

export interface NotificationRowShape {
  id: string;
  user_id: string;
  workspace_id: string;
  project_id: string | null;
  issue_id: string | null;
  type: string;
  title: string;
  body: string;
  read_at: Date | null;
}

export interface OutboxRowShape {
  event_id: string;
  dispatched_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
}

async function queryRows<T>(
  client: DbClient,
  sqlText: string,
  values: unknown[],
): Promise<T[]> {
  const result = await client.pool.query(sqlText, values);
  return result.rows as T[];
}

export async function readEventRow(
  client: DbClient,
  eventId: string,
): Promise<EventRowShape | undefined> {
  const rows = await queryRows<EventRowShape>(
    client,
    `SELECT id, processing_state, fingerprint, issue_id, rejection_reason, release
     FROM events WHERE id = $1`,
    [eventId],
  );
  return rows[0];
}

export async function readIssueRow(
  client: DbClient,
  issueId: string,
): Promise<IssueRowShape | undefined> {
  const rows = await queryRows<IssueRowShape>(
    client,
    `SELECT * FROM issues WHERE id = $1`,
    [issueId],
  );
  return rows[0];
}

export async function readIssuesByProject(
  client: DbClient,
  projectId: string,
): Promise<IssueRowShape[]> {
  return queryRows<IssueRowShape>(
    client,
    `SELECT * FROM issues WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
}

export async function readActivityRows(
  client: DbClient,
  issueId: string,
): Promise<ActivityRowShape[]> {
  return queryRows<ActivityRowShape>(
    client,
    `SELECT id, issue_id, actor_user_id, type, metadata_json
     FROM issue_activity WHERE issue_id = $1 ORDER BY created_at, id`,
    [issueId],
  );
}

export async function readNotificationRows(
  client: DbClient,
  issueId: string,
): Promise<NotificationRowShape[]> {
  return queryRows<NotificationRowShape>(
    client,
    `SELECT id, user_id, workspace_id, project_id, issue_id, type, title, body, read_at
     FROM notifications WHERE issue_id = $1 ORDER BY created_at, id`,
    [issueId],
  );
}

export async function readAffectedSessionRows(
  client: DbClient,
  issueId: string,
): Promise<Array<{ issue_id: string; telemetry_session_id: string }>> {
  return queryRows(
    client,
    `SELECT issue_id, telemetry_session_id
     FROM issue_affected_sessions WHERE issue_id = $1
     ORDER BY telemetry_session_id`,
    [issueId],
  );
}

export async function readOutboxRow(
  client: DbClient,
  eventId: string,
): Promise<OutboxRowShape | undefined> {
  const rows = await queryRows<OutboxRowShape>(
    client,
    `SELECT event_id, dispatched_at, attempt_count, last_error, created_at
     FROM event_processing_outbox WHERE event_id = $1`,
    [eventId],
  );
  return rows[0];
}

export async function countIssuesByProject(
  client: DbClient,
  projectId: string,
): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count FROM issues WHERE project_id = $1`,
    [projectId],
  );
  return Number(rows[0]?.count ?? "0");
}
