# Worker, Outbox and Issue Processing (Block 5)

Block 5 turns `apps/worker` from a lifecycle skeleton into the real
asynchronous processing pipeline: transactional outbox dispatcher, pg-boss
jobs, event normalization, deterministic fingerprinting, issue grouping,
aggregates, regression handling and PostgreSQL NOTIFY.

Issue REST API, issue list/detail UI, session timeline, SSE, source maps,
releases, reproduction generation, retention cleanup, invitations cleanup,
Ollama analysis and the public demo mode are explicitly out of scope; the next
block consumes the issues created here.

## Pipeline

```text
Browser SDK
    |
    v
POST /api/ingest/v1/batch
    |
    | one transaction per event:
    |   telemetry_sessions upsert
    |   events insert (processing_state = 'pending')
    |   event_processing_outbox insert (dispatched_at = NULL)
    v
event_processing_outbox
    |
    | dispatcher (FOR UPDATE SKIP LOCKED, bounded batch)
    |   pg-boss send  (job id = event id → stable dedupe)
    |   mark dispatched_at
    v
pg-boss  replaybug.process-event  { version: 1, eventId }
    |
    | worker consumer, bounded retries
    v
processEvent(eventId)  — one PostgreSQL transaction:
    lock event row (FOR UPDATE)
    re-read stored event              (jobs never carry payloads)
    normalize + fingerprint           (packages/db/src/domain)
    lock-or-create issue              (unique (project_id, fingerprint))
    register (issue, session) relation
    update aggregates (occurrence, first/last seen, first/last release)
    append issue_activity (created | regression_detected)
    create notification on regression when assigned
    mark event processed (fingerprint, issue_id)
    pg_notify replaybug_project_updates
    commit
```

## Component map

| Responsibility            | Location                                                  |
| ------------------------- | --------------------------------------------------------- |
| Config + env validation   | `apps/worker/src/config.ts`                               |
| Job contract + queue opts | `apps/worker/src/queues/process-event.ts`                 |
| pg-boss publish adapter   | `apps/worker/src/worker.ts` (`createPgBossPublisher`)     |
| Processor (transaction)   | `apps/worker/src/processors/process-event.ts`             |
| pg-boss consumer + logs   | `apps/worker/src/processors/process-event-handler.ts`     |
| Outbox dispatcher         | `apps/worker/src/dispatcher/outbox-dispatcher.ts`         |
| Shared publish routine    | `apps/worker/src/dispatcher/publish-batch.ts`             |
| Reconciliation            | `apps/worker/src/reconciliation/outbox-reconciliation.ts` |
| Composition root          | `apps/worker/src/worker.ts`, `apps/worker/src/index.ts`   |
| Normalization + grouping  | `packages/db/src/domain/` (pure functions)                |
| Repositories              | `packages/db/src/repositories/*.ts`                       |

The processor never issues Drizzle queries directly: it composes repository
functions so transaction boundaries stay reviewable.

## Job contract

```json
{ "version": 1, "eventId": "<uuid>" }
```

- Validated with Zod (`processEventJobSchema`) before any DB work.
- The payload never carries telemetry: the worker re-reads the stored event.
  This keeps jobs small, avoids duplicating telemetry inside the queue and
  prevents DB/job drift.
- Queue name: `replaybug.process-event` (the only queue in this block, on
  purpose).

## Idempotency layers (defense in depth)

1. **Job identity.** `send(..., { id: eventId })`. pg-boss inserts with
   `ON CONFLICT DO NOTHING` on the `(name, id)` primary key and returns `null`
   when the job already exists. Re-publishing the same event is a no-op.
2. **Event row lock.** `processEvent` locks the event row (`SELECT ... FOR
UPDATE`) before anything else. A redelivered job observes
   `processing_state = 'processed'` and returns without touching counters.
3. **Issue uniqueness.** `UNIQUE (project_id, fingerprint)` plus
   lock-or-create (`SELECT ... FOR UPDATE`, then `INSERT ... ON CONFLICT DO
NOTHING`, then re-select) guarantees exactly one issue per fingerprint even
   when two different events race.
4. **Occurrence counting.** `issues.occurrence_count` increments once per
   processed event inside the same transaction, never from a queue redelivery.
5. **Affected sessions.** `issue_affected_sessions` has a composite primary
   key `(issue_id, telemetry_session_id)` and `affected_session_count` only
   increments when that insert actually added a row.

There is no in-memory lock, mutex or process memory involved in correctness:
everything above is PostgreSQL state.

## Crash windows

| Crash point                                    | Result after restart                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Ingest transaction fails                       | nothing accepted; at-least-once retry by the client                           |
| `send` succeeded, crash before `dispatched_at` | dispatcher re-sends; pg-boss deduplicates by job id; row is marked dispatched |
| `dispatched_at` set, crash before the worker   | job is durable in pg-boss; the consumer picks it up                           |
| Processor committed, crash before job ack      | job retries; event is `processed`, so the retry is a no-op                    |
| Processor threw (transient failure)            | pg-boss retries with exponential backoff                                      |
| Processor threw forever (poison)               | bounded retries end in pg-boss `failed`, inspectable in `pgboss.job`          |

`dispatched_at` means **"durably handed to pg-boss"**, never "processed".
Final state lives in `events.processing_state` (`pending | processed |
rejected`). Outbox rows are kept for inspection and reconciliation.

## Outbox dispatcher and reconciliation

- Claim: `SELECT ... WHERE dispatched_at IS NULL ORDER BY created_at, event_id
LIMIT :batch FOR UPDATE SKIP LOCKED` — bounded, stable order, safe across
  multiple worker processes, never a full-table scan.
- Publish: `pg-boss send` with the stable job id. `null` (deduplicated) is
  success: the job already exists durably.
- Mark: `dispatched_at = now()` only after the publish confirmed.
- Failure: `attempt_count + 1` and a sanitized `last_error` (single line,
  bounded to 500 chars); the row stays claimable.
- Loop: non-overlapping timer; a full batch triggers a bounded immediate
  drain (max 10 iterations) instead of a hot loop.
- Reconciliation: a separate timer retries rows that stayed pending longer
  than the stale threshold, logs the stale count, and leaves everything else
  untouched. Both loops are stoppable and safe to run concurrently.

## Retry policy and poison jobs

- Queue options: `retryLimit: REPLAYBUG_JOB_RETRY_LIMIT` (default 4),
  `retryDelay: 1`, `retryBackoff: true`, `retryDelayMax: 60`,
  `expireInSeconds: 60` (verified in `pgboss.queue`).
- Deterministic stored-event problems are **not** retried: malformed stored
  payloads and unknown stored event types mark the event `rejected` with a
  machine-readable `rejection_reason` and complete the job successfully.
- Anything thrown (transient PostgreSQL failures, unexpected errors) fails the
  job; pg-boss retries with backoff and then leaves a `failed` job with
  `retry_count`, `output` and the source of the failure in `pgboss.job`.
- Poison jobs never crash the worker: the worker keeps processing other jobs.
- Unknown/deleted events complete as a no-op (`event-not-found`).

## Regression, ignored and investigating

| Current status  | New occurrence                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`          | counters/last-seen/last-release update; no activity                                                                                           |
| `investigating` | counters update; status unchanged                                                                                                             |
| `resolved`      | status → `open`, `resolved_at` → NULL, one `regression_detected` activity, one `issue_regression` notification when the issue has an assignee |
| `ignored`       | counters/last-seen/last-release update; never reopens; no regression activity or notification                                                 |

Notifications are in-app rows only (`notifications`): no email, no push, no
external service. Unassigned regressions still record the activity.

## PostgreSQL NOTIFY

After every successful issue change the transaction publishes:

```sql
SELECT pg_notify('replaybug_project_updates', '{"version":1,"type":"issue.created|issue.updated|issue.regressed","projectId":"...","issueId":"...","eventId":"..."}');
```

PostgreSQL delivers the notification after commit, so subscribers never see a
rolled-back change. The payload contains identifiers only — no telemetry, no
message text, no secrets. Block 6 subscribes to this channel for dashboard
SSE.

## pg-boss-owned objects

pg-boss owns and migrates its own schema (`REPLAYBUG_PGBOSS_SCHEMA`, default
`pgboss`, schema version 42 in pg-boss 12.33.0). ReplayBug never writes these
tables directly; tests read `pgboss.job` for inspection assertions only.

| Object                                    | Purpose                                              |
| ----------------------------------------- | ---------------------------------------------------- |
| `pgboss.version`                          | schema version journal                               |
| `pgboss.queue`                            | queue definitions (policy, retry, retention, notify) |
| `pgboss.job` / `pgboss.job_common`        | job rows (partitioned by queue name)                 |
| `pgboss.job_dependency`                   | flow dependencies (unused)                           |
| `pgboss.schedule`                         | cron/rule schedules (unused)                         |
| `pgboss.subscription`                     | pub/sub subscriptions (unused)                       |
| `pgboss.bam`                              | background async migrations                          |
| `pgboss.warning`                          | persisted operational warnings                       |
| `pgboss.queue_stats` (+ daily partitions) | aggregate queue state                                |

ReplayBug-managed tables: `issues`, `issue_activity`,
`issue_affected_sessions`, `notifications`, `events.fingerprint`,
`events.issue_id`, `event_processing_outbox.created_at`.

## Configuration

All values are validated with Zod at startup; invalid values fail fast with a
readable message and a non-zero exit.

| Variable                        | Default  | Bounds                      |
| ------------------------------- | -------- | --------------------------- |
| `REPLAYBUG_DATABASE_URL`        | —        | required                    |
| `REPLAYBUG_PGBOSS_SCHEMA`       | `pgboss` | non-empty                   |
| `REPLAYBUG_WORKER_CONCURRENCY`  | `2`      | 1–64                        |
| `REPLAYBUG_OUTBOX_BATCH_SIZE`   | `100`    | 1–1000                      |
| `REPLAYBUG_OUTBOX_POLL_MS`      | `1000`   | 100–60000                   |
| `REPLAYBUG_OUTBOX_RECONCILE_MS` | `60000`  | 1000–3600000                |
| `REPLAYBUG_JOB_RETRY_LIMIT`     | `4`      | 0–10                        |
| `REPLAYBUG_JOB_POLL_MS`         | `500`    | 500–60000 (pg-boss minimum) |

`process.env` is read only in `apps/worker/src/config.ts`.

## Startup and shutdown

Startup order: validate config → PostgreSQL health check → pg-boss start →
queue creation → consumer registration → dispatcher → reconciliation. Any
critical failure exits non-zero. There is no HTTP server: the worker is a
process, not a service.

Shutdown (SIGINT/SIGTERM): log → stop dispatching and reconciling → stop
claiming work (`offWork`) → drain in-flight jobs with a bounded timeout →
stop pg-boss → close the pool → exit 0. Idempotent: a second signal is
ignored.

## Why no Redis

Redis would add a second stateful dependency, a second failure mode and a
second consistency domain for zero capability here: PostgreSQL already
provides `FOR UPDATE SKIP LOCKED` (the same primitive pg-boss uses), unique
constraints, transactions and `NOTIFY`. The outbox row, the job and the issue
change stay in one database, so "accepted but never processed" is impossible
to reach silently. See `docs/adr/0001-transactional-outbox-and-pg-boss.md`.

## Tests

| File                                                               | Proof                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/src/domain/normalize.test.ts`                         | message/path/frame normalization, over-normalization guards                                                                                  |
| `packages/db/src/domain/fingerprint.test.ts`                       | exception/network/console/message/custom signatures and hash format                                                                          |
| `packages/db/src/migrations.test.ts`                               | empty DB → latest, Block 3 → latest, Block 4 → Block 5 with telemetry                                                                        |
| `apps/worker/src/worker.test.ts`                                   | config bounds/defaults, job contract, outbox error sanitization                                                                              |
| `apps/worker/src/processors/process-event.integration.test.ts`     | creation, grouping, aggregates, concurrency, regression, ignored, investigating, ordering, non-issues, rejection, custom fingerprint, NOTIFY |
| `apps/worker/src/dispatcher/outbox-dispatcher.integration.test.ts` | real pg-boss dispatch, crash window, publish failure, reconciliation, pg-boss retry, poison jobs, worker restart                             |
| `apps/worker/src/migrations.integration.test.ts`                   | a pre-migration pending event is processed by the new worker                                                                                 |
| `apps/demo/e2e-worker/worker.spec.ts`                              | browser → SDK → ingest → outbox → pg-boss → worker → issue, and cross-session grouping                                                       |

## Processing latency smoke

`pnpm worker:latency` (after `pnpm build`) runs one real exception through the
in-process pipeline and prints environment/hardware details plus the measured
latency. It is a reproducible observation, not a CI gate and not a marketing
SLA. On the development machine used for Block 5 (Windows 11, Ryzen AI 7 350,
PostgreSQL 17.11 in Docker) the pipeline took ~0.51–0.54 s warm
(dispatch ~0.2 s, process ~0.3 s); the first cold run after schema creation
took ~6.6 s.
