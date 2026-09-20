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

## Database migrations

`pnpm db:migrate` runs Drizzle Kit from `packages/db` and resolves its
connection string from `REPLAYBUG_DATABASE_URL` **in the process
environment**. When that variable is unset it falls back to
`postgres://localhost:5432/replaybug`, which does not match the Compose port
mapping (host `5544`) and fails with a connection error. Do not rely on the
repository-root `.env` for this command; pass the URL explicitly:

```bash
REPLAYBUG_DATABASE_URL=postgres://replaybug:replaybug@localhost:5544/replaybug pnpm db:migrate
```

PowerShell equivalent for the same shell session:

```powershell
$env:REPLAYBUG_DATABASE_URL = "postgres://replaybug:replaybug@localhost:5544/replaybug"
pnpm db:migrate
```

Migrations are forward-only Drizzle files in `packages/db/drizzle`; Block 10
AI analysis adds `0008_ai_analyses.sql`. Never edit a released migration.

## Optional local Ollama analysis

AI analysis is an optional enhancement, not infrastructure. ReplayBug works
fully with the feature disabled: ingest, grouping, issue detail, timelines,
retention, deletion, and deterministic Playwright reproduction never depend on
Ollama, and `/health/ready` never reports AI or provider status.

Configure a local Ollama endpoint in the API and worker environments:

```bash
REPLAYBUG_OLLAMA_URL=http://localhost:11434
REPLAYBUG_OLLAMA_MODEL=<your-local-model>
# Optional. Default 30000 ms; valid range 1000-120000.
REPLAYBUG_OLLAMA_TIMEOUT_MS=30000
```

- Set **both** the URL and the model, or neither. Setting only one, an
  invalid URL (non-`http(s)`, credentials, query, fragment, control
  characters), or an out-of-range timeout marks the capability
  `misconfigured`; it never blocks API or worker startup.
- Any local model name works — use `<your-local-model>` as a placeholder.
  ReplayBug does not require, recommend, or download a specific model, and it
  never calls Ollama's model pull API. Install and serve the model yourself.
- The endpoint is trusted environment-only configuration and is never exposed
  by the API or controlled by a request.
- The three variables are commented out in `.env.example` and are safe to
  leave unset.

### Docker note

The root Compose setup is unchanged: `docker compose up -d postgres` brings up
PostgreSQL only, and there is no default Compose dependency on Ollama. If you
later run the placeholder API/worker services in Compose, point them at your
Ollama instance with the service DNS name from inside the network:

```bash
REPLAYBUG_OLLAMA_URL=http://ollama:11434
```

If Ollama runs on the Docker host instead, use
`http://host.docker.internal:11434`. Do not add an Ollama service to the
default Compose profile, and do not make API/worker depend on it.

### Degraded behavior

While Ollama is down, slow, or misconfigured, only AI analysis fails. Requests
still create a durable analysis row; the worker retries transient provider
failures within its bounded budget and then records a terminal failure such as
`AI_ANALYSIS_PROVIDER_UNAVAILABLE` or `AI_ANALYSIS_TIMEOUT` (misconfiguration
fails immediately as `AI_ANALYSIS_DISABLED` / `AI_ANALYSIS_MISCONFIGURED`, and
an expired occurrence as `AI_ANALYSIS_INVALID_EVIDENCE`). The dashboard shows
the failure reason and, for retryable failures (timeout, provider unavailable
or rejected, invalid model response), offers a new analysis request while the
capability is configured. Nothing in the core pipeline pauses, and ready
history stays readable.

Prompts, evidence bundles, and raw model responses are never logged; worker
logs carry identifiers, status, error code, and duration only. Ready results
are labeled hypotheses and render as inert text. See
[Optional local AI analysis](architecture/ai-analysis.md) for the full privacy,
validation, retry, and labeling contract.
