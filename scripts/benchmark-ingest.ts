#!/usr/bin/env node
/**
 * Self-contained local ReplayBug ingest and issue-list benchmark.
 *
 * It creates a migrated, isolated PostgreSQL database, launches real API and
 * worker child processes, drives ingest over HTTP, and removes every resource
 * before exiting. It is intentionally local-only, bounded, and not an SLA.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);
const DEFAULT_DATABASE_URL =
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
const DEFAULT_EVENTS = 10_000;
const MAX_EVENTS = 100_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 16;
const WARMUP_EVENTS = 500;
const DATASET_EVENTS = 100_000;
const DATASET_ISSUES = 1_000;
const DATASET_SESSIONS = 500;
const LATENCY_SAMPLES = 15;
const QUERY_SAMPLES = 20;
const READY_TIMEOUT_MS = 30_000;
const INGEST_PATH = "/api/ingest/v1/batch";
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../packages/db/drizzle", import.meta.url),
);

type BenchmarkOptions = {
  events: number;
  batchSize: number;
  concurrency: number;
};

type BatchPayload = {
  protocol_version: 1;
  sdk_name: string;
  sdk_version: string;
  session: {
    sdk_session_id: string;
    browser: {
      name: string;
      version: string;
      os_name: string;
      os_version: string;
      device_type: "desktop";
      viewport_width: number;
      viewport_height: number;
    };
    initial_url: string;
    release: string;
    environment: string;
  };
  events: Array<Record<string, unknown>>;
};

type IngestResult = {
  durationsMs: number[];
  accepted: number;
  failures: number;
};

type Child = {
  name: string;
  process: ChildProcess;
  output: string[];
};

type BenchmarkDatabase = {
  databaseUrl: string;
  databaseName: string;
  pool: Pool;
  cleanup: () => Promise<void>;
};

type Fixture = {
  projectId: string;
  cookie: string;
  publicKey: string;
};

type QueryResult = {
  name: string;
  median: string;
  p95: string;
  max: string;
};

let cleanupActive: (() => Promise<void>) | undefined;
let shuttingDown = false;

function usage(): string {
  return `Usage: pnpm benchmark:ingest [options]

Creates an isolated local PostgreSQL database, runs real ReplayBug API and
worker processes, then measures HTTP ingest, asynchronous issue availability,
and authenticated issue-list queries. All generated data and processes are
removed at the end. This is not an SLA or CI gate.

Options:
  --events <n>         Primary HTTP ingest events (default: ${DEFAULT_EVENTS}, max: ${MAX_EVENTS})
  --batch-size <n>     Events per request (default/max: ${DEFAULT_BATCH_SIZE})
  --concurrency <n>    Concurrent requests (default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY})
  --help               Show this help

Configuration:
  REPLAYBUG_DATABASE_URL optionally selects the local PostgreSQL server used
  to create the isolated replaybug_benchmark_* database. It must be loopback.
  No ingest DSN, key, or remote endpoint is accepted or required.`;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseBoundedInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseOptions(argv: string[]): BenchmarkOptions | null {
  const values = new Map<string, string | true>();
  const supported = new Set([
    "--events",
    "--batch-size",
    "--concurrency",
    "--help",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const [name, inline] = argument.split("=", 2);
    if (!supported.has(name)) fail(`Unknown option: ${argument}`);
    if (name === "--help") {
      if (inline !== undefined) fail("--help does not accept a value");
      values.set(name, true);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail(`${name} requires a value`);
    if (values.has(name)) fail(`${name} may only be provided once`);
    values.set(name, value);
    if (inline === undefined) index += 1;
  }
  if (values.has("--help")) return null;
  const stringValue = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return {
    events: parseBoundedInteger(
      stringValue("--events"),
      "--events",
      DEFAULT_EVENTS,
      MAX_EVENTS,
    ),
    batchSize: parseBoundedInteger(
      stringValue("--batch-size"),
      "--batch-size",
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
    concurrency: parseBoundedInteger(
      stringValue("--concurrency"),
      "--concurrency",
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
    ),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

function databaseUrlFromEnv(): string {
  const value = process.env["REPLAYBUG_DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("REPLAYBUG_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !isLoopbackHost(url.hostname)
  ) {
    fail("REPLAYBUG_DATABASE_URL must use a loopback PostgreSQL host");
  }
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    fail("generated an unsafe PostgreSQL identifier");
  return `"${value}"`;
}

async function createBenchmarkDatabase(): Promise<BenchmarkDatabase> {
  const baseUrl = databaseUrlFromEnv();
  const databaseName = `replaybug_benchmark_${process.pid}_${randomBytes(8).toString("hex")}`;
  if (databaseName.length > 63)
    fail("generated benchmark database name is too long");
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const benchmarkUrl = new URL(baseUrl);
  benchmarkUrl.pathname = `/${databaseName}`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let pool: Pool | undefined;
  let created = false;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    try {
      await pool?.end();
    } catch (error) {
      firstError = error;
    }
    try {
      if (created) {
        await adminPool.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
        );
      }
    } catch (error) {
      firstError ??= error;
    }
    try {
      await adminPool.end();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    pool = new Pool({
      connectionString: benchmarkUrl.toString(),
      max: 20,
      connectionTimeoutMillis: 5_000,
    });
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    return {
      databaseUrl: benchmarkUrl.toString(),
      databaseName,
      pool,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function getFreeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (address === null || typeof address === "string")
    fail("could not allocate a loopback port");
  return address.port;
}

function startChild(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Child {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: string[] = [];
  const capture = (chunk: Buffer): void => {
    output.push(chunk.toString("utf8"));
    if (output.length > 40) output.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { name, process: child, output };
}

async function stopChild(child: Child | undefined): Promise<void> {
  if (child === undefined || child.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.process.once("exit", () => resolve()),
  );
  child.process.kill("SIGTERM");
  await Promise.race([exited, sleep(5_000)]);
  if (child.process.exitCode === null) {
    child.process.kill("SIGKILL");
    await Promise.race([exited, sleep(5_000)]);
  }
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  children: Child[],
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exited = children.find((child) => child.process.exitCode !== null);
    if (exited !== undefined) {
      throw new Error(
        `${exited.name} exited during startup: ${exited.output.join("").slice(-2_000)}`,
      );
    }
    try {
      if (await predicate()) return;
    } catch {
      // The service or database can still be starting.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApi(baseUrl: string, children: Child[]): Promise<void> {
  await waitFor(
    "API readiness",
    async () => {
      const response = await fetch(`${baseUrl}/health/ready`);
      return response.status === 200;
    },
    children,
  );
}

async function waitForWorker(
  pool: Pool,
  schema: string,
  children: Child[],
): Promise<void> {
  await waitFor(
    "worker pg-boss schema",
    async () => {
      const result = await pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
        [schema],
      );
      return result.rows[0]?.exists === true;
    },
    children,
  );
}

function apiUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl}/`).toString();
}

function cookieHeader(headers: Headers): string {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies =
    withGetSetCookie.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
  const header = cookies
    .map((cookie) => cookie.split(";", 1)[0])
    .filter((cookie): cookie is string => cookie !== undefined)
    .join("; ");
  if (header === "")
    throw new Error("sign-up response did not return a session cookie");
  return header;
}

async function apiJson<T>(
  baseUrl: string,
  path: string,
  options: RequestInit & { expected: number | number[] },
): Promise<T> {
  const { expected, ...request } = options;
  const response = await fetch(apiUrl(baseUrl, path), request);
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${request.method ?? "GET"} ${path} failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

async function createFixture(
  baseUrl: string,
  origin: string,
): Promise<Fixture> {
  const signup = await fetch(apiUrl(baseUrl, "/api/auth/sign-up/email"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      email: `benchmark-${randomUUID()}@example.invalid`,
      password: "BenchmarkPass123!",
      name: "Local Benchmark",
    }),
  });
  if (signup.status !== 200 && signup.status !== 201) {
    throw new Error(`benchmark sign-up failed with HTTP ${signup.status}`);
  }
  const cookie = cookieHeader(signup.headers);
  const headers = { "Content-Type": "application/json", cookie };
  const workspace = await apiJson<{ id: string }>(
    baseUrl,
    "/api/v1/workspaces",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Local Benchmark Workspace" }),
      expected: 201,
    },
  );
  const created = await apiJson<{
    project: { id: string };
    bootstrap: { key: string };
  }>(baseUrl, `/api/v1/workspaces/${workspace.id}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Local Benchmark Project" }),
    expected: 201,
  });
  await apiJson(baseUrl, `/api/v1/projects/${created.project.id}/origins`, {
    method: "POST",
    headers,
    body: JSON.stringify({ origin }),
    expected: 201,
  });
  return {
    projectId: created.project.id,
    cookie,
    publicKey: created.bootstrap.key,
  };
}

function createPayload(
  startSequence: number,
  count: number,
  kind: "message" | "exception" = "message",
): BatchPayload {
  const timestamp = new Date().toISOString();
  const event =
    kind === "exception"
      ? {
          event_id: randomUUID(),
          sequence_number: startSequence,
          event_type: "exception",
          timestamp,
          payload: {
            values: [
              {
                type: "TypeError",
                value: `Benchmark checkout exception ${randomUUID()}`,
                stacktrace: {
                  frames: [
                    {
                      filename: "http://127.0.0.1/checkout.ts",
                      function: "submitOrder",
                      lineno: 42,
                      colno: 7,
                      in_app: true,
                    },
                  ],
                },
                mechanism: { type: "generic", handled: true },
              },
            ],
          },
        }
      : undefined;
  return {
    protocol_version: 1,
    sdk_name: "replaybug-local-benchmark",
    sdk_version: "1.0.0",
    session: {
      sdk_session_id: randomUUID(),
      browser: {
        name: "benchmark",
        version: "1.0",
        os_name: platform(),
        os_version: release(),
        device_type: "desktop",
        viewport_width: 1440,
        viewport_height: 900,
      },
      initial_url: "http://127.0.0.1/benchmark/checkout",
      release: startSequence % 2 === 0 ? "web@3.2.0" : "web@3.1.0",
      environment: startSequence % 3 === 0 ? "staging" : "production",
    },
    events:
      event === undefined
        ? Array.from({ length: count }, (_, offset) => ({
            event_id: randomUUID(),
            sequence_number: startSequence + offset,
            event_type: "message",
            timestamp,
            payload: {
              message: `Synthetic checkout telemetry ${startSequence + offset}`,
              level: "info",
            },
          }))
        : [event],
  };
}

async function sendBatch(
  baseUrl: string,
  publicKey: string,
  origin: string,
  payload: BatchPayload,
): Promise<{ durationMs: number; accepted: number }> {
  const started = performance.now();
  const response = await fetch(apiUrl(baseUrl, INGEST_PATH), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ReplayBug-Key": publicKey,
      Origin: origin,
    },
    body: JSON.stringify(payload),
  });
  const durationMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as {
    accepted?: unknown;
    rejected?: unknown;
  };
  const accepted = typeof body.accepted === "number" ? body.accepted : 0;
  if (accepted !== payload.events.length || body.rejected !== 0) {
    throw new Error("ingest response did not accept the complete batch");
  }
  return { durationMs, accepted };
}

async function runIngest(
  options: BenchmarkOptions,
  baseUrl: string,
  publicKey: string,
  origin: string,
  eventCount: number,
): Promise<IngestResult> {
  const payloads: BatchPayload[] = [];
  for (let sequence = 0; sequence < eventCount; sequence += options.batchSize) {
    payloads.push(
      createPayload(
        sequence,
        Math.min(options.batchSize, eventCount - sequence),
      ),
    );
  }
  const result: IngestResult = { durationsMs: [], accepted: 0, failures: 0 };
  let next = 0;
  async function sender(): Promise<void> {
    while (next < payloads.length) {
      const payload = payloads[next];
      next += 1;
      if (payload === undefined) return;
      try {
        const sent = await sendBatch(baseUrl, publicKey, origin, payload);
        result.durationsMs.push(sent.durationMs);
        result.accepted += sent.accepted;
      } catch {
        result.failures += 1;
      }
    }
  }
  await Promise.all(
    Array.from({ length: options.concurrency }, () => sender()),
  );
  return result;
}

async function waitForProjectProcessingDrain(
  pool: Pool,
  projectId: string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pending: string }>(
      "SELECT count(*) FILTER (WHERE processing_state = 'pending')::text AS pending FROM events WHERE project_id = $1",
      [projectId],
    );
    if (Number(result.rows[0]?.pending) === 0) return;
    await sleep(100);
  }
  throw new Error(
    "timed out waiting for warmup events to leave the worker queue",
  );
}

async function waitForProcessedIssue(
  pool: Pool,
  projectId: string,
  clientEventId: string,
  children: Child[],
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exited = children.find((child) => child.process.exitCode !== null);
    if (exited !== undefined) {
      throw new Error(
        `${exited.name} exited while processing latency sample: ${exited.output.join("").slice(-2_000)}`,
      );
    }
    const result = await pool.query<{
      processing_state: string;
      issue_id: string | null;
    }>(
      "SELECT processing_state, issue_id FROM events WHERE project_id = $1 AND client_event_id = $2",
      [projectId, clientEventId],
    );
    const row = result.rows[0];
    if (row?.processing_state === "processed" && row.issue_id !== null) return;
    await sleep(25);
  }
  const pending = await pool.query<{
    processing_state: string;
    issue_id: string | null;
    dispatched_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT e.processing_state, e.issue_id, o.dispatched_at, o.last_error
     FROM events e LEFT JOIN event_processing_outbox o ON o.event_id = e.id
     WHERE e.project_id = $1 AND e.client_event_id = $2`,
    [projectId, clientEventId],
  );
  const state = pending.rows[0];
  throw new Error(
    `timed out waiting for accepted exception to become an available issue (state=${state?.processing_state ?? "missing"}, dispatched=${state?.dispatched_at !== null}, outboxError=${state?.last_error ?? "none"}; worker=${
      children
        .find((child) => child.name === "worker")
        ?.output.join("")
        .slice(-1_000) ?? "no output"
    })`,
  );
}

async function measureWorkerLatency(
  pool: Pool,
  fixture: Fixture,
  baseUrl: string,
  origin: string,
  children: Child[],
): Promise<number[]> {
  const samples: number[] = [];
  for (let sample = 0; sample < LATENCY_SAMPLES; sample += 1) {
    const payload = createPayload(sample + 1_000_000, 1, "exception");
    const eventId = String(payload.events[0]?.event_id);
    await sendBatch(baseUrl, fixture.publicKey, origin, payload);
    const acceptedAt = performance.now();
    await waitForProcessedIssue(pool, fixture.projectId, eventId, children);
    samples.push(performance.now() - acceptedAt);
  }
  return samples;
}

async function createRetainedDataset(
  pool: Pool,
  projectId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO issues (
       project_id, fingerprint, fingerprint_signature, type, title,
       normalized_message, status, severity, first_seen_at, last_seen_at,
       first_release, last_release, occurrence_count, affected_session_count
     )
     SELECT $1, lpad(to_hex(gs), 64, '0'), 'benchmark-signature-' || gs,
       'exception',
       CASE WHEN gs % 5 = 0 THEN 'Checkout payment failure ' || gs ELSE 'Catalog rendering failure ' || gs END,
       CASE WHEN gs % 5 = 0 THEN 'checkout payment timeout during confirmation' ELSE 'catalog rendering error while loading product data' END,
       (ARRAY['open','investigating','resolved','ignored'])[(gs % 4) + 1],
       CASE WHEN gs % 7 = 0 THEN 'warning' ELSE 'error' END,
       now() - (gs || ' days')::interval,
       now() - ((gs % 60) || ' hours')::interval,
       (ARRAY['web@3.0.0','web@3.1.0','web@3.2.0'])[(gs % 3) + 1],
       (ARRAY['web@3.0.0','web@3.1.0','web@3.2.0'])[(gs % 3) + 1],
       1 + (gs % 500), 1 + (gs % 100)
     FROM generate_series(1, $2) AS gs`,
    [projectId, DATASET_ISSUES],
  );
  await pool.query(
    `INSERT INTO telemetry_sessions (
       project_id, sdk_session_id, environment, release, started_at, last_seen_at,
       initial_url, browser_name, browser_version, os_name, os_version,
       device_type, viewport_width, viewport_height, sdk_version
     )
     SELECT $1, 'benchmark-session-' || gs,
       (ARRAY['production','staging','development'])[(gs % 3) + 1],
       (ARRAY['web@3.0.0','web@3.1.0','web@3.2.0'])[(gs % 3) + 1],
       now() - (gs || ' hours')::interval, now() - ((gs % 30) || ' minutes')::interval,
       'http://127.0.0.1/benchmark/' || gs, 'Chrome', '124', 'Linux', 'benchmark',
       'desktop', 1440, 900, '1.0.0'
     FROM generate_series(1, $2) AS gs`,
    [projectId, DATASET_SESSIONS],
  );
  await pool.query(
    `INSERT INTO issue_tags (project_id, name, slug)
     VALUES ($1, 'Frontend', 'frontend'), ($1, 'Checkout', 'checkout'), ($1, 'Performance', 'performance')`,
    [projectId],
  );
  await pool.query(
    `INSERT INTO issue_tag_assignments (issue_id, tag_id)
     SELECT i.id, t.id
     FROM issues i CROSS JOIN issue_tags t
     WHERE i.project_id = $1
       AND i.fingerprint_signature LIKE 'benchmark-signature-%'
       AND ((t.slug = 'checkout' AND i.title LIKE 'Checkout%')
         OR (t.slug = 'frontend' AND i.title LIKE 'Catalog%')
         OR (t.slug = 'performance' AND i.occurrence_count > 400))
     ON CONFLICT DO NOTHING`,
    [projectId],
  );
  const issueRows = await pool.query<{ id: string }>(
    "SELECT id FROM issues WHERE project_id = $1 AND fingerprint_signature LIKE 'benchmark-signature-%' ORDER BY created_at, id",
    [projectId],
  );
  const sessionRows = await pool.query<{ id: string }>(
    "SELECT id FROM telemetry_sessions WHERE project_id = $1 AND sdk_session_id LIKE 'benchmark-session-%' ORDER BY started_at, id",
    [projectId],
  );
  const issueIds = issueRows.rows.map((row) => row.id);
  const sessionIds = sessionRows.rows.map((row) => row.id);
  if (
    issueIds.length < DATASET_ISSUES ||
    sessionIds.length !== DATASET_SESSIONS
  )
    fail("retained fixture did not create its expected dimensions");
  for (let offset = 0; offset < DATASET_EVENTS; offset += 10_000) {
    const count = Math.min(10_000, DATASET_EVENTS - offset);
    await pool.query(
      `INSERT INTO events (
         project_id, telemetry_session_id, client_event_id, sequence_number,
         event_type, occurred_at, received_at, environment, release, page_url,
         payload_json, issue_id, processing_state
       )
       SELECT $1,
         ($2::uuid[])[(gs % cardinality($2::uuid[])) + 1],
         'benchmark-event-' || ($4 + gs), gs,
         'exception', now() - ((gs % 60) || ' hours')::interval,
         now() - ((gs % 60) || ' hours')::interval,
         (ARRAY['production','staging','development'])[(gs % 3) + 1],
         (ARRAY['web@3.0.0','web@3.1.0','web@3.2.0'])[(gs % 3) + 1],
         'http://127.0.0.1/benchmark/' || gs,
         jsonb_build_object('message', CASE WHEN gs % 5 = 0 THEN 'checkout payment timeout' ELSE 'catalog rendering event' END, 'tags', ARRAY['benchmark', 'synthetic']),
         ($3::uuid[])[(gs % cardinality($3::uuid[])) + 1], 'processed'
       FROM generate_series(1, $5) AS gs`,
      [projectId, sessionIds, issueIds, offset, count],
    );
  }
  const count = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM events WHERE project_id = $1 AND client_event_id LIKE 'benchmark-event-%'",
    [projectId],
  );
  if (Number(count.rows[0]?.count) !== DATASET_EVENTS)
    fail("retained fixture event count is not exactly 100000");
}

async function measureIssueList(
  baseUrl: string,
  fixture: Fixture,
): Promise<QueryResult[]> {
  const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
  const samples = [
    ["default last_seen desc", "?limit=25"],
    ["status", "?status=open&limit=25"],
    ["environment", "?environment=production&limit=25"],
    ["release", "?release=web%403.2.0&limit=25"],
    ["free-text search", "?q=checkout%20payment&limit=25"],
    [
      "status + environment + date range",
      `?status=open&environment=staging&since=${encodeURIComponent(since)}&limit=25`,
    ],
    ["occurrence_count desc", "?sort=occurrence_count&order=desc&limit=25"],
  ] as const;
  const results: QueryResult[] = [];
  for (const [name, query] of samples) {
    const path = `/api/v1/projects/${fixture.projectId}/issues${query}`;
    for (let warmup = 0; warmup < 5; warmup += 1) {
      await apiJson(baseUrl, path, {
        headers: { cookie: fixture.cookie },
        expected: 200,
      });
    }
    const durations: number[] = [];
    for (let sample = 0; sample < QUERY_SAMPLES; sample += 1) {
      const started = performance.now();
      await apiJson(baseUrl, path, {
        headers: { cookie: fixture.cookie },
        expected: 200,
      });
      durations.push(performance.now() - started);
    }
    results.push({
      name,
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: percentile(durations, 1),
    });
  }
  return results;
}

async function explainFindings(
  pool: Pool,
  projectId: string,
): Promise<string[]> {
  const plans = await Promise.all([
    pool.query<{ "QUERY PLAN": unknown }>(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM issues WHERE project_id = $1 ORDER BY last_seen_at DESC, id ASC LIMIT 26",
      [projectId],
    ),
    pool.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT i.id FROM issues i WHERE i.project_id = $1
       AND EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND e.environment = 'production')
       ORDER BY i.last_seen_at DESC, i.id ASC LIMIT 26`,
      [projectId],
    ),
    pool.query<{ "QUERY PLAN": unknown }>(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM issues WHERE project_id = $1 AND (title ILIKE '%checkout payment%' OR normalized_message ILIKE '%checkout payment%') ORDER BY last_seen_at DESC, id ASC LIMIT 26",
      [projectId],
    ),
  ]);
  return plans.map((result, index) => {
    const raw = result.rows[0]?.["QUERY PLAN"];
    const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
    const root = Array.isArray(plan)
      ? (plan[0] as {
          Plan?: { "Node Type"?: string };
          "Execution Time"?: number;
        })
      : undefined;
    const node = root?.Plan?.["Node Type"] ?? "unknown plan";
    const time =
      typeof root?.["Execution Time"] === "number"
        ? root["Execution Time"].toFixed(2)
        : "unknown";
    return `${["default ordering", "environment EXISTS", "free-text predicate"][index] ?? "query"}: root ${node}, execution ${time} ms (EXPLAIN ANALYZE after fixture warmup)`;
  });
}

function percentile(values: number[], quantile: number): string {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(quantile * sorted.length) - 1,
  );
  return sorted[index]?.toFixed(2) ?? "n/a";
}

async function commit(): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: process.cwd() },
    );
    return result.stdout.trim();
  } catch {
    return "unavailable";
  }
}

function printReport(
  options: BenchmarkOptions,
  database: BenchmarkDatabase,
  postgres: string,
  ingest: IngestResult,
  durationMs: number,
  latency: number[],
  queries: QueryResult[],
  findings: string[],
  revision: string,
): void {
  const cpu = cpus()[0];
  const seconds = durationMs / 1_000;
  const requests = Math.ceil(options.events / options.batchSize);
  console.log("ReplayBug local benchmark report");
  console.log("================================");
  console.log(`date/time:         ${new Date().toISOString()}`);
  console.log(`commit:            ${revision}`);
  console.log(`node:              ${process.version}`);
  console.log(`platform:          ${platform()} ${release()} (${arch()})`);
  console.log(
    `cpu:               ${cpu === undefined ? "unknown" : cpu.model}`,
  );
  console.log(`logical CPUs:      ${cpus().length}`);
  console.log(`memory:            ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`);
  console.log(`postgres:          ${postgres}`);
  console.log(
    `database:          ${database.databaseName} (removed during cleanup)`,
  );
  console.log("");
  console.log("HTTP ingest (real API)");
  console.log(`events requested:  ${options.events}`);
  console.log(`events accepted:   ${ingest.accepted}`);
  console.log(`batch size:        ${options.batchSize}`);
  console.log(`concurrency:       ${options.concurrency}`);
  console.log(`duration:          ${durationMs.toFixed(2)} ms`);
  console.log(`request count:     ${requests}`);
  console.log(`request failures:  ${ingest.failures}`);
  console.log(`events/sec:        ${(ingest.accepted / seconds).toFixed(2)}`);
  console.log(`requests/sec:      ${(requests / seconds).toFixed(2)}`);
  console.log(
    `request p50/p95/p99: ${percentile(ingest.durationsMs, 0.5)} / ${percentile(ingest.durationsMs, 0.95)} / ${percentile(ingest.durationsMs, 0.99)} ms`,
  );
  console.log("");
  console.log(
    "Accepted -> worker processed -> issue available (real HTTP/outbox/pg-boss/worker)",
  );
  console.log(`samples:           ${latency.length}`);
  console.log(
    `p50/p95/p99/max:   ${percentile(latency, 0.5)} / ${percentile(latency, 0.95)} / ${percentile(latency, 0.99)} / ${percentile(latency, 1)} ms`,
  );
  console.log("");
  console.log(
    `Retained query fixture: exactly ${DATASET_EVENTS} direct-SQL events across ${DATASET_ISSUES} issues and ${DATASET_SESSIONS} sessions.`,
  );
  console.log(
    "Authenticated issue-list API (five warmups, then 20 samples each; setup excluded)",
  );
  for (const query of queries)
    console.log(
      `${query.name}: median ${query.median} ms, p95 ${query.p95} ms, max ${query.max} ms`,
    );
  console.log("EXPLAIN ANALYZE summary:");
  for (const finding of findings) console.log(`- ${finding}`);
  console.log(
    "Optimization conclusion: no speculative indexes or production optimizations were applied; inspect a measured pathology before proposing one.",
  );
  console.log(
    "Scope: isolated local PostgreSQL only; synthetic data and child processes are removed after this report. Not an SLA or load test.",
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) {
    console.log(usage());
    return;
  }
  let database: BenchmarkDatabase | undefined;
  let api: Child | undefined;
  let worker: Child | undefined;
  let artifactDir: string | undefined;
  const cleanup = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopChild(worker).catch(() => undefined);
    await stopChild(api).catch(() => undefined);
    await database?.cleanup().catch(() => undefined);
    if (artifactDir !== undefined)
      await rm(artifactDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
  };
  cleanupActive = cleanup;
  try {
    database = await createBenchmarkDatabase();
    artifactDir = await mkdtemp(join(tmpdir(), "replaybug-benchmark-"));
    const apiPort = await getFreeLoopbackPort();
    const origin = `http://127.0.0.1:${apiPort}`;
    const apiBase = origin;
    const bossSchema = `pgboss_benchmark_${process.pid}_${randomBytes(4).toString("hex")}`;
    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      LOG_LEVEL: "silent",
      REPLAYBUG_DATABASE_URL: database.databaseUrl,
      REPLAYBUG_AUTH_SECRET: randomBytes(32).toString("hex"),
      REPLAYBUG_USER_HMAC_SECRET: randomBytes(32).toString("hex"),
      REPLAYBUG_ARTIFACT_DIR: artifactDir,
      REPLAYBUG_ARTIFACT_STAGING_DIR: artifactDir,
      REPLAYBUG_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE: "10000",
      REPLAYBUG_INGEST_RATE_LIMIT_EVENTS_PER_MINUTE: "1000000",
      REPLAYBUG_INGEST_MAX_BATCH_EVENTS: String(MAX_BATCH_SIZE),
    };
    api = startChild("API", ["--import", "tsx", "apps/api/src/server.ts"], {
      ...sharedEnv,
      REPLAYBUG_API_HOST: "127.0.0.1",
      REPLAYBUG_API_PORT: String(apiPort),
      REPLAYBUG_API_URL: apiBase,
      REPLAYBUG_WEB_URL: origin,
    });
    worker = startChild(
      "worker",
      ["--import", "tsx", "apps/worker/src/index.ts"],
      {
        ...sharedEnv,
        REPLAYBUG_PGBOSS_SCHEMA: bossSchema,
        REPLAYBUG_OUTBOX_POLL_MS: "100",
        REPLAYBUG_OUTBOX_RECONCILE_MS: "1000",
        REPLAYBUG_JOB_POLL_MS: "500",
        REPLAYBUG_WORKER_CONCURRENCY: "16",
      },
    );
    await waitForApi(apiBase, [api, worker]);
    await waitForWorker(database.pool, bossSchema, [api, worker]);
    const postgresResult = await database.pool.query<{
      server_version: string;
    }>("SELECT current_setting('server_version') AS server_version");
    const fixture = await createFixture(apiBase, origin);
    const warmup = await runIngest(
      options,
      apiBase,
      fixture.publicKey,
      origin,
      WARMUP_EVENTS,
    );
    if (warmup.failures > 0 || warmup.accepted !== WARMUP_EVENTS) {
      throw new Error(
        `warmup ingest was incomplete: accepted ${warmup.accepted}/${WARMUP_EVENTS}, failures ${warmup.failures}`,
      );
    }
    await waitForProjectProcessingDrain(database.pool, fixture.projectId);
    const latency = await measureWorkerLatency(
      database.pool,
      fixture,
      apiBase,
      origin,
      [api, worker],
    );
    const started = performance.now();
    const ingest = await runIngest(
      options,
      apiBase,
      fixture.publicKey,
      origin,
      options.events,
    );
    const durationMs = performance.now() - started;
    if (ingest.failures > 0 || ingest.accepted !== options.events) {
      throw new Error(
        `primary ingest was incomplete: accepted ${ingest.accepted}/${options.events}, failures ${ingest.failures}`,
      );
    }
    await createRetainedDataset(database.pool, fixture.projectId);
    const queries = await measureIssueList(apiBase, fixture);
    const findings = await explainFindings(database.pool, fixture.projectId);
    printReport(
      options,
      database,
      postgresResult.rows[0]?.server_version ?? "unavailable",
      ingest,
      durationMs,
      latency,
      queries,
      findings,
      await commit(),
    );
  } finally {
    await cleanup();
    cleanupActive = undefined;
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanupActive?.().finally(() => process.exit(1));
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
