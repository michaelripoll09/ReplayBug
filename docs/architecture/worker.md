# Worker, Outbox and Operations

`apps/worker` runs asynchronous issue processing and bounded operational cleanup.
It has no HTTP server. PostgreSQL, pg-boss, and the shared local artifact
directory are its runtime dependencies.

## Pipeline

```text
ingest transaction -> event outbox -> pg-boss process-event -> issue update
reproduction outbox -> pg-boss generate-reproduction -> reproduction result
invitation expiry / retention / artifact-delete outboxes -> bounded cleanup loops
```

Event and reproduction dispatchers use stable job IDs, transactional outboxes,
`FOR UPDATE SKIP LOCKED`, reconciliation, and idempotent processors. Jobs carry
identifiers rather than telemetry; the worker rereads current database state.

## Operational cleanup

- **Expired invitations:** a non-overlapping runner retires bounded batches of
  pending expired invitations, releasing the active-email slot without exposing
  token material.
- **Retention:** a non-overlapping transaction deletes a bounded set of eligible
  raw events, then eligible sessions, using per-project UTC cutoffs. Pending
  event dispatch and pending reproductions prevent event deletion. Lifetime
  issue data and affected-session deduplication survive; see
  [Tenancy](tenancy.md#retention).
- **Artifact deletion:** confirmed project/workspace deletion creates durable
  outbox rows before relational cascade. The runner validates each canonical
  key, deletes the local file, and completes the row only after deletion. Rows
  remain retryable on failure; duplicate keys and missing files are safe.

The cleanup loops never overlap their own in-flight pass. A transaction failure
rolls back and the next scheduled pass retries. Logs are sanitized aggregates
(counts, batch size, or generic error code), never telemetry, artifact paths,
tokens, generated reproduction code, or secrets.

## Configuration

`apps/worker/src/config.ts` is the only worker environment reader. Startup
validates all values and fails fast for invalid configuration.

| Variable                                     | Default  | Bounds / purpose                                  |
| -------------------------------------------- | -------- | ------------------------------------------------- |
| `REPLAYBUG_DATABASE_URL`                     | —        | required PostgreSQL URL (`DATABASE_URL` fallback) |
| `REPLAYBUG_PGBOSS_SCHEMA`                    | `pgboss` | non-empty pg-boss schema                          |
| `REPLAYBUG_WORKER_CONCURRENCY`               | `2`      | 1–64 consumers per queue                          |
| `REPLAYBUG_OUTBOX_BATCH_SIZE`                | `100`    | 1–1000 event dispatch rows                        |
| `REPLAYBUG_OUTBOX_POLL_MS`                   | `1000`   | 100–60000                                         |
| `REPLAYBUG_OUTBOX_RECONCILE_MS`              | `60000`  | 1000–3600000                                      |
| `REPLAYBUG_REPRODUCTION_OUTBOX_BATCH_SIZE`   | `100`    | 1–1000                                            |
| `REPLAYBUG_REPRODUCTION_OUTBOX_POLL_MS`      | `1000`   | 100–60000                                         |
| `REPLAYBUG_REPRODUCTION_OUTBOX_RECONCILE_MS` | `60000`  | 1000–3600000                                      |
| `REPLAYBUG_JOB_RETRY_LIMIT`                  | `4`      | 0–10                                              |
| `REPLAYBUG_JOB_POLL_MS`                      | `500`    | 500–60000                                         |
| `REPLAYBUG_INVITATION_CLEANUP_BATCH_SIZE`    | `100`    | 1–100 expired invitations per pass                |
| `REPLAYBUG_INVITATION_CLEANUP_INTERVAL_MS`   | `60000`  | 1000–3600000                                      |
| `REPLAYBUG_RETENTION_CLEANUP_BATCH_SIZE`     | `100`    | 1–1000 raw events/sessions per pass               |
| `REPLAYBUG_RETENTION_CLEANUP_INTERVAL_MS`    | `60000`  | 1000–3600000                                      |
| `REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE`     | `100`    | 1–100 deletion-outbox rows per pass               |
| `REPLAYBUG_ARTIFACT_DELETION_POLL_MS`        | `1000`   | 100–60000                                         |

`REPLAYBUG_ARTIFACT_DIR` is resolved by the shared artifact package rather than
this schema. When valid, API and worker must point to the same **writable**
local directory. If worker artifact storage is invalid or unavailable, the
worker logs a safe warning and continues event processing with raw-stack
fallback; artifact deletion is paused until storage is available.

## Startup and shutdown

Startup validates configuration, checks PostgreSQL health, starts pg-boss and
queues, registers consumers, then starts dispatch, reconciliation, invitation,
retention, and—when storage is available—artifact deletion runners.

On `SIGINT` or `SIGTERM`, the worker stops scheduling cleanup and dispatch
passes, waits for in-flight cleanup work, removes queue workers, drains
in-flight jobs through pg-boss's bounded 15-second graceful timeout, and closes
its pool. Shutdown is idempotent. A second signal does not start a competing
drain.

## Correctness boundaries

- `dispatched_at` means handed durably to pg-boss, not processed.
- Event and reproduction outbox rows may be republished safely because job IDs
  are stable and terminal processors are no-ops.
- `FOR UPDATE SKIP LOCKED` keeps multiple worker processes from claiming the
  same bounded cleanup rows.
- Retention and artifact deletion are different lifecycles: retention deletes
  eligible raw telemetry; artifact deletion removes local release blobs after
  structured deletion.

## Tests

Focused integration tests cover real PostgreSQL/pg-boss dispatch and recovery,
retention locking and protected pending evidence, invitation expiry, artifact
outbox retries/idempotence, governance/deletion behavior, issue export, and
migration paths. Repository CI also runs format, lint, typecheck, test, build,
OpenAPI drift, and Chromium E2E; these are repository gates, not arbitrary
worker commands.
