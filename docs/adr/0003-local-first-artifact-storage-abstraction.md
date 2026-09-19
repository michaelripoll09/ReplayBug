# ADR 0003 — Local-first artifact storage abstraction

Status: accepted (Block 7; master spec §47 topic 6)

## Problem

Release artifacts (source maps, minified assets) need durable blob
storage that a self-hosted single-node deployment can run with zero paid
services: PostgreSQL plus the local filesystem is the whole stateful
infrastructure (master spec §55). Byte columns in Postgres would bloat
the database and its backups; an object store (S3 or equivalent) would
add a vendor, credentials, and a network dependency to every symbolication.
The design must also survive the store being down without taking
telemetry down with it (master spec §54).

## Options considered

1. **Bytea columns in PostgreSQL.** Keeps one backend, but large blobs
   punish every `pg_dump`, every replica byte, and every row-level query
   touching the table. Rejected.
2. **S3-compatible object storage.** Scales, but mandates credentials, a
   network hop on the symbolication path, and either a paid account or a
   second self-hosted service — against the no-paid-services,
   no-mandatory-S3 constraints. Rejected.
3. **Local-first `ArtifactStorage` abstraction (chosen).** A narrow
   streaming interface (`put`/`get`/`exists`/`delete`, server-generated
   keys only) with a filesystem backend today; a future backend
   implements the same seam without touching upload, symbolication, or
   dashboard code.

## Decision

- `ArtifactStorage` is the only seam. `LocalArtifactStorage` is rooted
  at `REPLAYBUG_ARTIFACT_DIR` (dev default `~/.replaybug/artifacts`,
  outside the repo; containers use `/var/lib/replaybug/artifacts` on the
  `replaybug_artifacts` named volume).
- **Keys are server-generated** (`<project-id>/<release-id>/<content-hash>`,
  UUIDs + lowercase-hex SHA-256), re-validated plus containment-checked
  on every operation. The user-facing `artifactPath` stays relational
  metadata in Postgres and is never a disk path, so traversal is
  impossible by design; upload paths are canonicalized and rejected
  (never normalized into loadability) in the same shared package.
- **Writes are atomic** (temp file + fsync + rename, cleanup on every
  failure path) with temp-file compensation on the upload pipeline, so
  outages never leave orphaned blobs or rows.
- **Access is split**: the API writes, the worker only reads
  (`Pick<ArtifactStorage, "get">`, read-only volume mount). Configuration
  is validated in one shared home (`@replaybug/artifacts` `config.ts`):
  the API fails fast on a bad root, while the worker degrades to raw
  symbolication instead of failing startup.
- **Outages degrade, never cascade**: ingest stays available, dashboard
  reads and SSE keep working, uploads fail safe with `503`
  `ARTIFACT_STORAGE_UNAVAILABLE`, and symbolication falls back to raw
  with an honest `storage_unavailable` status. `/health/ready` reports
  `checks.artifactStorage` informationally without flipping readiness.

## Consequences

- Self-hosting stays boring: one database, one volume, both backed up
  together (rows reference blobs by content hash, so restore both sides;
  see `docs/self-hosting.md`).
- Single-node durability only: no replication, no CDN, no multi-writer
  story — acceptable for the self-host target, and the seam keeps a
  future backend possible.
- Cost: operators own disk growth until retention cleanup arrives in a
  later block; release+path immutability means bytes only accumulate.
- No external fetching, ever: maps enter only through the upload
  pipeline, so there is no SSRF surface and no availability coupling to
  third-party map servers.
