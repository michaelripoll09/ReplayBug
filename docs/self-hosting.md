# Self-Hosting — Local Artifact Storage (Block 9)

ReplayBug's stateful infrastructure is PostgreSQL plus a local filesystem.
`ArtifactStorage` currently has only a local backend: there is no S3, Redis,
object-store integration, deployment automation, or one-command production
full-stack deployment.

## Configuration

| Variable                                 | Meaning                                 | Default                                           |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `REPLAYBUG_ARTIFACT_DIR`                 | Shared artifact root for API and worker | `~/.replaybug/artifacts` (outside the repository) |
| `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES`      | API per-file upload cap                 | `26214400` (25 MiB)                               |
| `REPLAYBUG_ARTIFACT_STAGING_DIR`         | API multipart staging area              | OS temp directory                                 |
| `REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE` | Worker deletion rows per pass           | `100`                                             |
| `REPLAYBUG_ARTIFACT_DELETION_POLL_MS`    | Worker deletion-pass interval           | `1000` ms                                         |

The shared artifact package validates an explicit artifact root as an absolute,
safe non-root directory outside source trees. Blank or unsafe values fail the
API startup contract. The worker degrades safely if it cannot resolve storage:
symbolication falls back to raw stacks and artifact deletion pauses while ingest
and issue processing continue.

**API and worker must use the same writable `REPLAYBUG_ARTIFACT_DIR`.** API
uploads create files; the worker reads maps and deletes files from the durable
artifact-deletion outbox. A read-only worker mount is incorrect for Block 9.

## Docker scope

The root Compose setup runs PostgreSQL by default:

```bash
docker compose up -d postgres
```

It provides a PostgreSQL 17 healthcheck, host port `5544 → 5432`, and a
persistent database volume. `replaybug_artifacts` and the canonical container
path `/var/lib/replaybug/artifacts` document the intended shared volume
contract, but full-stack API/worker/web/demo service images remain placeholders.
Web and demo are not containerized. Do not treat Compose as a production
deployment command.

If operators later wire the placeholder services, mount the artifact volume at
the same writable path for both API and worker and set
`REPLAYBUG_ARTIFACT_DIR=/var/lib/replaybug/artifacts` in each process.

## Artifact lifecycle

Release uploads use server-generated keys
`<project-id>/<release-id>/<content-hash>`. Keys are validated and never exposed
by dashboard/API metadata. Upload writes are atomic and compensate on failed
database insertion.

A confirmed project or workspace deletion first validates every stored artifact
against that canonical key shape and inserts unique durable outbox rows in the
same transaction before relational cascade. The worker claims a bounded batch
with `FOR UPDATE SKIP LOCKED`, unlinks local files, then marks rows complete.
A failed unlink stays retryable. If the process dies after unlinking but before
the database update, retry treats the already-missing file as successful. This
is local filesystem behavior only.

Telemetry retention is separate: it removes eligible raw events and sessions
according to project retention, but does not remove release blobs. See
[Tenancy](architecture/tenancy.md#retention) and
[Source maps](architecture/source-maps.md).

## Backup and recovery

Back up PostgreSQL and the artifact directory/volume together. A database row
can otherwise reference a missing map, which degrades honestly to
`storage_unavailable` and raw-stack grouping instead of failing ingest.

When artifact deletion appears stalled:

1. Confirm API and worker resolve the same writable `REPLAYBUG_ARTIFACT_DIR`.
2. Check worker aggregate logs for retryable artifact-deletion failures; they
   intentionally do not contain paths or artifact contents.
3. Correct storage access or availability, then let the normal bounded runner
   retry; do not manually invent or alter outbox rows.
4. Verify database backups before attempting any filesystem restoration.

## Storage-outage degradation

While local storage is unavailable, ingest remains available, events still gain
durable outbox rows, and the worker creates issues using raw-stack fallback.
Uploads fail safely with `ARTIFACT_STORAGE_UNAVAILABLE`; dashboard reads and
SSE remain available. `/health/ready` reports database readiness and exposes
artifact storage as informational status rather than making storage an HTTP
readiness failure.
