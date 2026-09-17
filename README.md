# ReplayBug

Developer observability for reproducible bugs: privacy-safe browser failure
context, grouped issues, session timelines, and Playwright reproduction
tests — on a self-hostable stack with no paid services.

> **Status: foundation bootstrap only.** The monorepo, tooling, health
> probes, and smoke screens exist. The product workflow (auth, ingest,
> grouping, reproductions, dashboard) is not implemented yet.

## What exists today

- pnpm workspaces + Turborepo monorepo (`apps/*`, `packages/*`)
- Next.js smoke page at `apps/web` ("ReplayBug" + tagline, light/dark toggle)
- Fastify API at `apps/api` with `GET /health/live`, `GET /health/ready`
  (PostgreSQL check), `GET /api/v1/meta`, request IDs, contracts-based
  error envelope, and OpenAPI docs in non-production (`/docs`)
- Worker lifecycle skeleton at `apps/worker` (validated config, PG check,
  graceful shutdown, empty pg-boss job registry)
- Vite + React smoke screen at `apps/demo` ("ReplayBug Demo App",
  production source maps enabled)
- Shared packages: `@replaybug/observability` (Pino), `@replaybug/contracts`
  (Zod: health, meta, error envelope), `@replaybug/db` (pg + Drizzle config,
  health helper, no domain tables yet), `@replaybug/sdk` (version metadata
  only), `@replaybug/cli` (`replaybug --version/--help`), `@replaybug/api-client`
  (OpenAPI strategy stub), `@replaybug/ui` (`cn` + `Button`), `@replaybug/config`
  (shared TypeScript presets)
- PostgreSQL 17 via Docker Compose with healthcheck and persistent volume
- GitHub Actions CI (format, lint, typecheck, tests with Postgres, build)

## What is explicitly not built yet

Auth, workspaces, projects, telemetry ingest, real SDK capture, issue
grouping, fingerprinting, functional pg-boss jobs, source maps, Playwright
generator, functional dashboard, Ollama analysis, invitations, RBAC, and
functional SSE. See `` for the full plan.

## Stack

Node.js 24, TypeScript (strict), pnpm workspaces, Turborepo, Next.js (App
Router) + React + Tailwind CSS, Fastify + Zod, PostgreSQL 17, Drizzle ORM,
pg-boss (structure only), Pino, Vitest, Vite. No Redis. No paid services.

## Requirements

- Node.js 24
- pnpm 10 (`npm install -g pnpm@10.17.0` if missing; repo pins `pnpm@10.17.0`
  via `packageManager`)
- Docker (for local PostgreSQL; unit tests use mocks and run without it)

## Quick start

```bash
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
docker compose up -d postgres
pnpm install
pnpm dev
```

Seed/migration commands (`pnpm db:migrate`, `pnpm db:seed`) arrive with the
first domain tables and are not available in this block.

## Ports

| Service                 | Default | Variable                  |
| ----------------------- | ------- | ------------------------- |
| web                     | 3000    | `REPLAYBUG_WEB_PORT`      |
| api                     | 4001    | `REPLAYBUG_API_PORT`      |
| demo                    | 5173    | `REPLAYBUG_DEMO_PORT`     |
| postgres (host mapping) | 5544    | `REPLAYBUG_POSTGRES_PORT` |

`pnpm dev` starts web + api + worker + demo concurrently with prefixed logs
via Turborepo. API docs (non-production): `http://localhost:4001/docs`.

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node packages/cli/bin/replaybug.js --version
```

## Monorepo structure

```text
replaybug/
├─ apps/
│  ├─ web/        # Next.js dashboard smoke screen
│  ├─ api/        # Fastify health + meta API
│  ├─ worker/     # Worker lifecycle skeleton (pg-boss registry stub)
│  └─ demo/       # Vite smoke screen (source maps on)
├─ packages/
│  ├─ sdk/            # Browser SDK metadata only
│  ├─ cli/            # replaybug --version/--help
│  ├─ db/             # pg + Drizzle infra (no domain tables yet)
│  ├─ contracts/      # Zod health/meta/error contracts
│  ├─ api-client/     # OpenAPI client strategy stub
│  ├─ ui/             # cn + Button (shadcn-compatible base)
│  ├─ observability/  # Pino logger factory
│  └─ config/         # Shared tsconfig presets
├─ docs/
│  ├─ specs/replaybug-master-spec.md
│  └─ adr/
├─ scripts/
├─ docker/
├─ .github/workflows/
├─ docker-compose.yml
└─ README.md
```

No application imports private internals from another application; shared
behavior lives in `packages/*` with explicit `exports`.

## Specification

The source of truth is
[``]().
Foundation decisions never override it.

## License

MIT — see [LICENSE](LICENSE).
