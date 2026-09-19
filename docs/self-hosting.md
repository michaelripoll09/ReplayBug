# Self-Hosting — Artifact Storage (Block 7)

ReplayBug's stateful infrastructure is PostgreSQL plus the local
filesystem (master spec §55). Block 7 adds the second half of that pair:
the **local release-artifact store** holding uploaded source maps and
minified assets. No S3, no paid service, no external map server.

## Configuration

| Variable                            | Meaning                                         | Default                                               |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `REPLAYBUG_ARTIFACT_DIR`            | Artifact root directory (API + worker share it) | `~/.replaybug/artifacts` (OS-local, outside the repo) |
| `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES` | Per-file upload cap, bytes                      | `26214400` (25 MiB)                                   |
| `REPLAYBUG_ARTIFACT_STAGING_DIR`    | Multipart staging area                          | OS temp dir                                           |

Validation (fail-fast at startup, one shared home in
`@replaybug/artifacts` — `config.ts`, consumed by both services):

- An explicit `REPLAYBUG_ARTIFACT_DIR` must be an absolute directory
  outside repo source trees — never a filesystem root, home dir,
  `packages/`, `apps/`, `node_modules/`, `.git/`, `public/`, `src/`, or
  `uploads/`. The API rejects unsafe values during config load; the
  worker's `LocalArtifactStorage.fromEnv()` enforces the same rule.
- A set-but-blank variable fails fast instead of silently falling back.
- `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES` must be a positive integer of
  bytes (≤1024 MiB); the API additionally bounds it in its Zod schema
  and enforces it in multipart limits _before_ unbounded buffering.

The API validates fail-fast (a bad root must never boot an uploader);
the worker resolves the same contract but **degrades** on misconfiguration
(warn + run without storage, symbolication falls back to raw) because
ingest must survive storage problems. See
[Source maps](architecture/source-maps.md) for the lookup rules.

## Docker volume

`docker-compose.yml` declares the named persistent volume:

```yaml
volumes:
  replaybug_artifacts:
```

The canonical container path is `/var/lib/replaybug/artifacts`, mounted
at the **same path** by both services (declared for the full-stack
services arriving per `docker/README.md`; local development today runs
API/worker as processes with `REPLAYBUG_ARTIFACT_DIR` pointing at the
same directory):

```yaml
services:
  api:
    volumes:
      - replaybug_artifacts:/var/lib/replaybug/artifacts # read/write
  worker:
    volumes:
      - replaybug_artifacts:/var/lib/replaybug/artifacts:ro # read-only
```

- The volume persists across API/worker restarts and redeploys — no
  artifact bytes are ever committed to the repo (the dev default lives
  outside the source tree, and `.gitignore` covers `.artifacts/`).
- The worker mount is read-only: the worker only ever reads blobs
  (`Pick<ArtifactStorage, "get">`); all writes go through the API
  upload pipeline.
- `docker compose config` must pass after any compose edit; it is the
  cheap assertion that the volume and mounts are declared.

## Backup

Back up the database **and** the artifact volume together:

```bash
docker run --rm \
  -v replaybug_artifacts:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar -czf "/backup/replaybug-artifacts-$(date +%F).tgz" -C /data .
```

Consistency notes:

- DB rows (`release_artifacts`) reference blobs by content hash. A row
  whose blob is missing degrades honestly (`storage_unavailable`, raw
  stacks) instead of crashing — but restore both sides to avoid a
  permanently degraded release.
- Upload compensation already prevents orphans on the write path (temp
  cleanup, blob deleted when the DB insert fails), so a backup taken
  mid-upload may briefly contain an unreferenced blob; that is harmless.
- Retention cleanup does not exist yet — plan volume growth against
  release frequency until a later block adds it.

## Permissions

- The artifact root must be **writable by the API** (uploads, temp
  files, atomic renames) and **readable by the worker**. When API and
  worker run as different UIDs, grant both (group read/execute on the
  tree, write for the API's UID); in containers this falls out of the
  shared named volume.
- Keep the root outside any served web directory — blobs are internal
  by design (never served to browsers, never rendered beyond escaped
  text in the dashboard).

## Local-first abstraction

`ArtifactStorage` (`put`/`get`/`exists`/`delete`, streaming,
server-generated keys only) is the seam: today the only backend is
`LocalArtifactStorage`; a future backend implements the same interface
without touching upload, symbolication, or dashboard code. Keys are
`<project-id>/<release-id>/<content-hash>` and are re-validated plus
containment-checked on every operation (see
[Source maps](architecture/source-maps.md#storage-path-security)).

## Access pattern: API writes, worker reads

| Operation                                | Service          | Failure mode                                             |
| ---------------------------------------- | ---------------- | -------------------------------------------------------- |
| Preflight check, multipart upload        | API (read/write) | `503 ARTIFACT_STORAGE_UNAVAILABLE`, no row stored        |
| Symbolication map reads                  | Worker (read)    | `storage_unavailable`, raw fallback, issue still created |
| Ingest, issues, sessions, SSE, dashboard | API + worker     | unaffected (master spec §54)                             |

## Storage-outage degradation

When the store is down, the system stays up in degraded form:

- **Ingest available**: batches still accepted (202) with durable outbox
  rows; the worker processes them to raw-fallback issues.
- **Dashboard available**: issues, issue detail, event detail (raw
  frames), and the SSE stream keep working.
- **Upload 503s**: `ARTIFACT_STORAGE_UNAVAILABLE`, nothing stored.
- **Symbolication raw fallback**: affected events keep the honest
  `storage_unavailable` status permanently; new events after recovery
  map genuinely again.
- **Readiness**: `/health/ready` keeps reporting readiness from the
  database and adds `checks.artifactStorage: up | down | unknown` as
  informational status — storage never flips the status code, so
  orchestrators do not restart a healthy API during a storage outage.

## What self-hosting still lacks

Full containerization (web/api/worker/demo images with persistent
volumes) arrives in a later block per `docker/README.md`; today Compose
provides PostgreSQL (`docker compose up -d postgres`, host port
`5544 → 5432`) while API/worker run as local processes. The
`replaybug_artifacts` volume and the `/var/lib/replaybug/artifacts`
convention are declared now so that block has a contract to implement.
