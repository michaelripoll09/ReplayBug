# ReplayBug

Developer observability for reproducible bugs: privacy-safe browser failure
context, grouped issues, session timelines, and Playwright reproduction
tests — on a self-hostable stack with no paid services.

> **Status: Block 2 foundation.** Auth, tenancy, workspaces, projects,
> environments, origins and public-key bootstrap exist with real PostgreSQL.
> Event ingest, SDK capture, issues, jobs, SSE, releases, source maps,
> Playwright generation and dashboard UI are explicitly not built yet.

## What exists today

- pnpm workspaces + Turborepo monorepo (`apps/*`, `packages/*`)
- Next.js smoke page at `apps/web` ("ReplayBug" + tagline, light/dark toggle)
- Fastify API at `apps/api` with `GET /health/live`, `GET /health/ready`
  (PostgreSQL check), `GET /api/v1/meta`, request IDs, contracts-based
  error envelope, and OpenAPI docs in non-production (`/docs`)
- Better Auth email/password at `/api/auth/*` with PostgreSQL persistence,
  HttpOnly + Secure-in-production + SameSite Lax cookies, session rotation,
  strict dashboard CORS with credentials, and `GET /api/v1/me`
- Workspaces (`GET /api/v1/workspaces`, `POST`, `GET one`, `PATCH`; no delete),
  projects (nested + by-id + transactional idempotent delete), environments,
  origins and public-key rotation with central RBAC (owner/admin/member/viewer)
  and audit logs
- Worker lifecycle skeleton at `apps/worker` (validated config, PG check,
  graceful shutdown, empty pg-boss job registry)
- Vite + React smoke screen at `apps/demo` ("ReplayBug Demo App",
  production source maps enabled)
- Shared packages: `@replaybug/observability` (Pino), `@replaybug/contracts`
  (Zod: health, meta, error envelope, user/workspace/project/env/origin/keys),
  `@replaybug/db` (pg + Drizzle schema, migrations, repositories, origin parser,
  key crypto), `@replaybug/sdk` (version metadata only), `@replaybug/cli`
  (`replaybug --version/--help`), `@replaybug/api-client` (OpenAPI strategy stub),
  `@replaybug/ui` (`cn` + `Button`), `@replaybug/config` (shared TS presets)
- Real Drizzle versioned migrations (`packages/db/drizzle`) and dev-only seed
  (`pnpm db:seed`: demo user/workspace/project/prod env/dev env/localhost origin)
- PostgreSQL 17 via Docker Compose with healthcheck and persistent volume
- GitHub Actions CI (format, lint, typecheck, tests with Postgres, build)

## What is explicitly not built yet

Telemetry ingest, real SDK capture, issue grouping, fingerprinting,
functional pg-boss jobs, source maps, Playwright generator, functional
dashboard/auth UI, Ollama analysis, invitations, GitHub OAuth, CLI secret
tokens, SSE, notifications, comments, releases, and onboarding visuals.
Web stays smoke. See `` for the full plan.

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
pnpm db:migrate
pnpm db:seed                # dev-only; DEMO/LOCAL ONLY creds, no telemetry data
pnpm dev
```

Auth runs locally with email/password (no OAuth, no paid services). Configure
`REPLAYBUG_AUTH_SECRET` (min 32 chars), `REPLAYBUG_API_URL`,
`REPLAYBUG_WEB_URL` and `REPLAYBUG_TRUSTED_ORIGINS` in `.env` (see
`.env.example`). Startup fails fast with a readable message when required
config is missing.

Tenancy: one user creates a workspace (owner), then projects. Project slugs are
unique per workspace; workspace slugs are globally unique. Roles are
`owner|admin|member|viewer` with a central capability policy (see
`docs/architecture/tenancy.md`). Project creation returns a one-time `bootstrap`
with the public key plaintext, prefix, projectId and a FUTURE ingest endpoint
marked non-functional; the key is never shown again. Rotate via
`POST /api/v1/projects/:id/keys/public/rotate` (owner/admin).

Docker workflow: `docker compose up -d postgres` provides PostgreSQL 17 on
`5544->5432` with healthcheck and persistent volume. Migrations are
forward-only Drizzle files in `packages/db/drizzle`; never edit released
migrations.

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
│  ├─ api/        # Fastify health + meta + auth/tenancy API
│  ├─ worker/     # Worker lifecycle skeleton (pg-boss registry stub)
│  └─ demo/       # Vite smoke screen (source maps on)
├─ packages/
│  ├─ sdk/            # Browser SDK metadata only
│  ├─ cli/            # replaybug --version/--help
│  ├─ db/             # pg + Drizzle schema/migrations/repos/parsers
│  ├─ contracts/      # Zod health/meta/error + tenancy DTOs
│  ├─ api-client/     # OpenAPI client strategy stub
│  ├─ ui/             # cn + Button (shadcn-compatible base)
│  ├─ observability/  # Pino logger factory
│  └─ config/         # Shared tsconfig presets
├─ docs/
│  ├─ architecture/tenancy.md
│  ├─ specs/replaybug-master-spec.md
│  └─ adr/
├─ scripts/           # seed-dev (dev-only tenancy seed)
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
