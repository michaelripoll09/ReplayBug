/**
 * ReplayBug worker processing-latency smoke (reproducible, documented).
 *
 * Measures one thing honestly: how long an accepted error takes to become a
 * processed issue when the real pipeline runs locally.
 *
 * Path exercised (no mocks):
 *   ingest service transaction (event + outbox)
 *     -> outbox dispatcher
 *     -> pg-boss job
 *     -> worker processor (normalize + fingerprint + issue transaction)
 *
 * The script seeds an isolated project, starts the real worker runtime
 * in-process, calls the real ingest service, then polls the database until
 * the event is processed and the issue exists. It prints environment and
 * hardware information so the number is reproducible.
 *
 * Scope notes (on purpose):
 * - It measures in-process pipeline latency, not an HTTP round trip.
 * - It is not a CI gate and not a marketing SLA.
 * - The master spec's 5-second local-development target is a target, not a
 *   guarantee, and this script only reports what it observed.
 *
 * Usage:
 *   pnpm build
 *   pnpm worker:latency                       (REPLAYBUG_DATABASE_URL must be set)
 *   pnpm tsx --env-file=.env scripts/worker-latency-smoke.ts   (loads .env)
 */

import { randomUUID } from "node:crypto";
import { cpus, platform, arch, release, totalmem } from "node:os";
import { createLogger } from "@replaybug/observability";
import { createDbClient } from "@replaybug/db";
import { loadWorkerConfigFromEnv } from "../apps/worker/src/config.js";
import { startWorkerRuntime } from "../apps/worker/src/worker.js";
import { ingestBatch } from "../apps/api/src/services/ingest.js";
import { PROTOCOL_VERSION } from "@replaybug/contracts";

const SMOKE_SCHEMA = "pgboss_latency_smoke";

function log(line: string): void {
  // Smoke output is a plain report, not structured service logging.
  console.log(line);
}

async function main(): Promise<void> {
  if (!process.env["REPLAYBUG_DATABASE_URL"] && !process.env["DATABASE_URL"]) {
    throw new Error(
      "REPLAYBUG_DATABASE_URL is not set. Run with --env-file=.env or export it first (see .env.example).",
    );
  }
  const config = loadWorkerConfigFromEnv({
    ...process.env,
    NODE_ENV: "development",
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "silent",
    REPLAYBUG_PGBOSS_SCHEMA: SMOKE_SCHEMA,
    REPLAYBUG_OUTBOX_POLL_MS: "200",
    REPLAYBUG_JOB_POLL_MS: "500",
    REPLAYBUG_OUTBOX_RECONCILE_MS: "10000",
  });

  const client = createDbClient({
    databaseUrl: config.databaseUrl,
    maxConnections: 8,
    connectionTimeoutMs: 5000,
  });
  const logger = createLogger({
    service: "worker-latency-smoke",
    level: "silent",
  });

  const suffix = randomUUID().slice(0, 8);
  const userId = `latency-smoke-user-${suffix}`;
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const clientEventId = randomUUID();

  let runtime: Awaited<ReturnType<typeof startWorkerRuntime>> | null = null;

  try {
    await client.pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())`,
      [userId, "Latency Smoke", `latency-${suffix}@example.com`],
    );
    await client.pool.query(
      `INSERT INTO workspaces (id, name, slug, created_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, "Latency Smoke WS", `latency-ws-${suffix}`, userId],
    );
    await client.pool.query(
      `INSERT INTO projects (id, workspace_id, name, slug)
       VALUES ($1, $2, $3, $4)`,
      [projectId, workspaceId, "Latency Smoke", `latency-${suffix}`],
    );

    runtime = await startWorkerRuntime({ config, logger, client });

    const pgVersion = await client.pool.query(
      `SELECT version() AS version, current_setting('server_version') AS server_version`,
    );

    const testStart = new Date();
    const acceptedAt = Date.now();
    await ingestBatch(
      client.db,
      { projectId, keyPrefix: "smoke", requestId: randomUUID() },
      {
        protocol_version: PROTOCOL_VERSION,
        sdk_name: "latency-smoke",
        sdk_version: "0.0.0",
        session: {
          sdk_session_id: randomUUID(),
          browser: {
            name: "smoke",
            version: "0.0.0",
            os_name: platform(),
            os_version: release(),
            device_type: "desktop",
            viewport_width: 1280,
            viewport_height: 720,
          },
          initial_url: "http://localhost:5173/",
          release: "smoke@1.0.0",
          environment: "smoke",
        },
        events: [
          {
            event_id: clientEventId,
            sequence_number: 1,
            event_type: "exception",
            timestamp: new Date().toISOString(),
            payload: {
              values: [
                {
                  type: "TypeError",
                  value: `Cannot read properties of null (reading 'total') in run ${suffix}`,
                  stacktrace: {
                    frames: [
                      {
                        filename: "http://localhost:5173/src/App.tsx",
                        function: "triggerJsException",
                        lineno: 69,
                        colno: 11,
                        in_app: true,
                      },
                    ],
                  },
                  mechanism: { type: "generic", handled: true },
                },
              ],
            },
          },
        ],
      },
      {
        maxRequestsPerMinute: 60,
        maxEventsPerMinute: 1000,
        userHmacSecret: "latency-smoke-hmac-secret-0123456789abcdef",
      },
    );
    const ingestAcceptedAt = Date.now();

    const deadline = Date.now() + 30_000;
    let issueId: string | null = null;
    while (Date.now() < deadline) {
      const result = await client.pool.query(
        `SELECT processing_state, issue_id FROM events
         WHERE project_id = $1 AND client_event_id = $2`,
        [projectId, clientEventId],
      );
      const row = result.rows[0] as
        { processing_state: string; issue_id: string | null } | undefined;
      if (row?.processing_state === "processed" && row.issue_id !== null) {
        issueId = row.issue_id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const issueProcessedAt = Date.now();

    if (issueId === null) {
      throw new Error(
        "timed out waiting for the event to become a processed issue",
      );
    }

    const issue = await client.pool.query(
      `SELECT title, occurrence_count, affected_session_count FROM issues WHERE id = $1`,
      [issueId],
    );
    const outbox = await client.pool.query(
      `SELECT o.dispatched_at FROM event_processing_outbox o
       JOIN events e ON e.id = o.event_id
       WHERE e.project_id = $1 AND e.client_event_id = $2`,
      [projectId, clientEventId],
    );
    const dispatchedAtRaw = (outbox.rows[0] as { dispatched_at: Date | null })
      .dispatched_at;
    const dispatchedAt =
      dispatchedAtRaw === null ? null : dispatchedAtRaw.getTime();

    const cpu = cpus()[0];
    log("ReplayBug worker latency smoke");
    log("--------------------------------");
    log(`node:            ${process.version}`);
    log(`platform:        ${platform()} ${release()} (${arch()})`);
    log(
      `cpu:             ${cpu ? `${cpu.model} x${cpus().length}` : "unknown"}`,
    );
    log(`memory:          ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`);
    log(
      `postgres:        ${String((pgVersion.rows[0] as { server_version: string }).server_version)}`,
    );
    log(`pg-boss schema:  ${SMOKE_SCHEMA}`);
    log(`outbox poll:     ${config.outboxPollMs} ms`);
    log(`job poll:        ${config.jobPollMs} ms`);
    log(`worker conc.:    ${config.concurrency}`);
    log("");
    log(`ingest accepted at:   ${new Date(ingestAcceptedAt).toISOString()}`);
    log(`issue processed at:   ${new Date(issueProcessedAt).toISOString()}`);
    log(
      `latency (accepted → processed): ${issueProcessedAt - ingestAcceptedAt} ms (ingest service call: ${ingestAcceptedAt - acceptedAt} ms)`,
    );
    if (dispatchedAt !== null) {
      log(
        `  dispatch stage (accepted → outbox dispatched): ${dispatchedAt - ingestAcceptedAt} ms`,
      );
      log(
        `  process stage (dispatched → issue processed):  ${issueProcessedAt - dispatchedAt} ms`,
      );
    }
    log("");
    log(
      `issue:           ${String((issue.rows[0] as { title: string }).title)}`,
    );
    log(
      `occurrences:     ${String((issue.rows[0] as { occurrence_count: number }).occurrence_count)}, sessions: ${String((issue.rows[0] as { affected_session_count: number }).affected_session_count)}`,
    );
    log(
      `outbox:          dispatched_at=${String((outbox.rows[0] as { dispatched_at: Date | null }).dispatched_at !== null)}`,
    );
    log("");
    log(
      `scope: in-process pipeline only (outbox → pg-boss → processor → issue); no HTTP round trip, not a CI gate.`,
    );
    log(`window started:  ${testStart.toISOString()}`);
  } finally {
    try {
      await runtime?.stop();
    } catch {
      // Report the primary failure, not shutdown noise.
    }
    try {
      await client.pool.query(`DELETE FROM workspaces WHERE id = $1`, [
        workspaceId,
      ]);
      await client.pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
      await client.pool.query(`DROP SCHEMA IF EXISTS ${SMOKE_SCHEMA} CASCADE`);
    } catch (error) {
      console.error(
        `Cleanup failed (manual removal may be needed): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
