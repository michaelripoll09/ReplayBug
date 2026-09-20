# Docker

This directory holds supporting files for containerized runs.

## Current runnable scope

Local development can run PostgreSQL from the root Compose file:

```bash
docker compose up -d postgres
```

This starts PostgreSQL 17 with its healthcheck and persistent database volume.
The default host mapping is `5544 → 5432`.

## Current limits

Full-stack service images for API, worker, web, and demo remain placeholders.
The web dashboard and demo application are not containerized. Compose is
therefore not a one-command production deployment and does not provide
application deployment automation.

The `replaybug_artifacts` volume and `/var/lib/replaybug/artifacts` path are a
future full-stack wiring contract. When API and worker containers are wired,
both must mount that path read/write because the worker performs durable local
artifact cleanup as well as source-map reads. See
[Self-hosting](../docs/self-hosting.md) for the current local-storage contract.
