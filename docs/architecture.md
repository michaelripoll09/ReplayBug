# ReplayBug Architecture Overview

This is the index for ReplayBug's architecture documentation. Each topic
document covers one subsystem in depth; this page explains how they fit
together.

## System topology

```text
apps/web (Next.js dashboard)      apps/demo (Vite + React deliberately buggy app)
        |                                  |
        | dashboard API (session cookie)   | @replaybug/sdk (public ingest key)
        v                                  v
apps/api (Fastify: auth, governance, projects, ingest, exports, artifacts)
        | one transaction per accepted event: telemetry session + event + outbox
        v
PostgreSQL 17 <----- pg-boss <----- apps/worker
   |                                      |
   | release metadata, audit, retention,  | symbolication, issue/reproduction jobs,
   | invitation and artifact-delete outbox| bounded cleanup runners
   v                                      v
local filesystem artifact store <--- API and worker share REPLAYBUG_ARTIFACT_DIR
```

No Redis, external queue, or paid service is required. PostgreSQL plus the
local filesystem is the current stateful infrastructure.

## Topic documents

| Document                                                                         | Covers                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [architecture/tenancy.md](architecture/tenancy.md)                               | Auth, workspace governance, invitations, audit, retention and deletion        |
| [architecture/worker.md](architecture/worker.md)                                 | Ingest-to-issue pipeline, queues, cleanup runners, shutdown and configuration |
| [architecture/fingerprinting.md](architecture/fingerprinting.md)                 | Normalization and grouping rules                                              |
| [architecture/source-maps.md](architecture/source-maps.md)                       | Releases, local artifacts, symbolication and artifact deletion                |
| [architecture/reproduction-generator.md](architecture/reproduction-generator.md) | Retained-evidence Playwright generation and its retention behavior            |
| [architecture/ai-analysis.md](architecture/ai-analysis.md)                       | Optional local Ollama analysis, sanitized evidence and degraded operation     |
| [cli.md](cli.md)                                                                 | CLI release and source-map operations                                         |
| [self-hosting.md](self-hosting.md)                                               | Local artifact-storage operations and deletion troubleshooting                |
| [adr/](adr/README.md)                                                            | Architecture decision records                                                 |

## Issue export

`GET` issue export is authenticated and applies the same tenant-scoped
`issue:read` authorization as issue detail. It returns one sanitized JSON
document that may include allowlisted issue fields, tags, normalized issue
messages, an optional retained occurrence, raw/mapped/preferred stack views,
bounded sanitized timeline summaries (20 events before and 5 after the anchor),
and up to 20 safe reproduction summaries. The optional event must be a retained
occurrence of that exact issue; otherwise it is not found.

Exports never include raw telemetry payloads, comment bodies, reproduction
source code, fingerprint material, authentication data, secrets, or idempotency
data. The download filename is derived only from a conservative sanitized issue
ID (`replaybug-issue-<id>.json`), never an issue title or other user-controlled
string.

## Local-first artifact storage and cleanup

Release artifact bytes live outside PostgreSQL behind `ArtifactStorage`; release
metadata lives in PostgreSQL. The API writes uploads and the worker reads maps
**and deletes queued artifacts**, so both processes must use the same writable
`REPLAYBUG_ARTIFACT_DIR`. Keys are server-generated
`<project-id>/<release-id>/<content-hash>` values and are not returned by APIs.

Project and workspace deletion validates and queues those canonical keys in the
same database transaction before relational cascade. The artifact-deletion
outbox is idempotent and retried by the worker, so a local file may be removed
before a crash and safely treated as absent on retry. This is distinct from
telemetry retention: retention deletes eligible raw telemetry evidence, whereas
artifact deletion follows a project or workspace deletion request. See
[Source maps](architecture/source-maps.md) and [Self-hosting](self-hosting.md).

## Data flow rules that shape the design

- **Ingest stays short.** It validates, redacts, and writes session, event, and
  outbox state in one transaction; grouping never occurs on the request path.
- **Jobs carry identifiers, not telemetry.** Workers re-read database state.
- **Retention preserves lifetime aggregates.** It removes only eligible raw
  events and sessions; issue counters, activity/comments, reproductions, and
  the affected-session deduplication relation remain.
- **Correctness lives in PostgreSQL.** Unique constraints, transactions,
  `FOR UPDATE`, and `FOR UPDATE SKIP LOCKED` provide concurrency safety.
