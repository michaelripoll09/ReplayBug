# Docker

This directory holds supporting files for containerized runs.

## Current state (foundation)

Local development needs only PostgreSQL from the root `docker-compose.yml`:

```bash
docker compose up -d postgres
```

The full self-hosted stack (web, api, worker, demo containers with
persistent volumes) arrives in a later block per the master specification.
The authoritative topology is documented in
`` sections 55-56.
