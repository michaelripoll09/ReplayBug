# ReplayBug Architecture Overview

This is the index for ReplayBug's architecture documentation. Each topic
document covers one subsystem in depth; this page explains how they fit
together.

## System topology

```text
apps/web (Next.js dashboard)      apps/demo (Vite + React deliberately buggy app)
        |                                  |
        |  dashboard API (session cookie)  |  @replaybug/sdk (public ingest key)
        v                                  v
apps/api (Fastify: auth, tenancy, projects, keys, origins, ingest)
        |
        |  one transaction per accepted event:
        |  telemetry session + event + outbox row
        v
PostgreSQL 17  <----- pg-boss (own schema) <----- apps/worker
        ^                                            |
        |                                            | normalize → fingerprint →
        |                                            | issue update → activity →
        |                                            | notification → pg_notify
        |                                            v
        └──────── pg_notify replaybug_project_updates (dashboard SSE, Block 6)
```

No Redis, no external queue, no paid service: PostgreSQL plus the local
filesystem is the whole stateful infrastructure.

## Topic documents

| Document                                                         | Covers                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [architecture/tenancy.md](architecture/tenancy.md)               | Auth, workspaces, projects, environments, origins, keys, RBAC, audit                                                   |
| [architecture/frontend.md](architecture/frontend.md)             | Dashboard structure, theming, routing, API client conventions                                                          |
| [architecture/worker.md](architecture/worker.md)                 | Ingest→issue pipeline, outbox dispatcher, pg-boss usage, retries, crash windows, NOTIFY, worker configuration          |
| [architecture/fingerprinting.md](architecture/fingerprinting.md) | Normalization rules, signatures per event type, custom fingerprints, collision diagnostics, pre-source-map limitations |
| [adr/](adr/README.md)                                            | Architecture decision records                                                                                          |

## Data flow rules that shape the design

- **Ingest stays short.** It validates, redacts, and writes session + event +
  outbox row in one transaction. No fingerprinting or grouping happens on the
  request path.
- **Jobs carry identifiers, not telemetry.** A pg-boss job contains
  `{ version, eventId }`; the worker re-reads the event from PostgreSQL. Job
  payloads never duplicate or drift from stored telemetry.
- **Everything about one occurrence commits together.** Issue row, aggregates,
  event association, activity, regression notification and the NOTIFY payload
  share one transaction.
- **Correctness lives in PostgreSQL.** Unique constraints, `FOR UPDATE`, and
  `FOR UPDATE SKIP LOCKED` provide idempotency and concurrency safety; no
  process-local lock participates in correctness.
