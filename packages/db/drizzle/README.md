# ReplayBug Drizzle migrations

This directory contains forward-only, versioned PostgreSQL migrations.
Released migration files are immutable; create a new migration rather than
editing an existing one.

## Current migration history

`0000_broken_donald_blake.sql` through `0008_ai_analyses.sql` define the
current schema. Migration `0007` adds workspace invitations and the durable
artifact-deletion outbox, and expands the audit action constraint for Block 9
governance, retention, and deletion lifecycle actions. Migration `0008` adds
AI analysis history and its durable dispatch outbox for Block 10.

The application schema also includes workspace/project tenancy, telemetry and
issue aggregates, release artifact metadata, reproduction history, and audit
records. Artifact bytes are not stored here; only validated local-storage keys
and deletion-outbox state are persisted.

## Applying and verifying migrations

Run migrations with:

```bash
pnpm db:migrate
```

Migration tests use real temporary PostgreSQL databases. They prove both an
empty database can migrate to the latest schema and defined upgrade boundaries
can advance retained historical data to the current schema, including the
Block 9 (`0006` → `0007`) boundary. These are migration-path tests, not schema
snapshots or generated SQL rewrites.

Do not edit migration files, snapshots, package manifests, or generated
artifacts as part of ordinary documentation or operational work.
