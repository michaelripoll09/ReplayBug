# ReplayBug

Developer observability for reproducible bugs: privacy-safe browser failure
context, grouped issues, session timelines, and Playwright reproduction
tests — on a self-hostable stack with no paid services.

> **Status: Block 3 dashboard.** Auth, tenancy, onboarding, dashboard shell,
> environment/origin/key-rotation settings, typed OpenAPI client and Chromium
> E2E exist with real PostgreSQL. Event ingest, SDK capture, issues, sessions,
> timeline, Playwright generation, jobs, SSE, releases, source maps and
> notifications are explicitly not built yet.

## What exists today

- pnpm workspaces + Turborepo monorepo (`apps/*`, `packages/*`)
- Next.js dashboard at `apps/web`: smart `/` redirect, `/login`, `/register`
  (email/password, no OAuth), `/onboarding[/workspace|/project|/origin|/complete]`
  wizard, `/app/workspaces/[workspaceId]` and `/app/projects/[projectId]`
  overviews (real config data only, honest "Telemetry not configured yet"),
  `/app/projects/[projectId]/settings[/general|/environments|/origins|/keys]`
  with RBAC hide-or-readonly, sidebar + workspace switcher + theme
  (light/dark/system, no flash) + mobile drawer. See
  `docs/architecture/frontend.md`.
- Typed dashboard client at `packages/api-client`: `pnpm api:generate` builds
  Fastify in-process, writes `openapi/openapi.json` + `src/schema.d.ts`,
  `createReplayBugApiClient({ baseUrl, fetch })` with `credentials: include`
  and `{code,message,requestId,details}` normalization. CI fails on drift.
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
  (`replaybug --version/--help`), `@replaybug/api-client` (generated OpenAPI
  client, see above), `@replaybug/ui` (`cn` + `Button`), `@replaybug/config`
  (shared TS presets)
- Real Drizzle versioned migrations (`packages/db/drizzle`) and dev-only seed
  (`pnpm db:seed`: demo user/workspace/project/prod env/dev env/localhost origin)
- PostgreSQL 17 via Docker Compose with healthcheck and persistent volume
- GitHub Actions CI (format, lint, typecheck, tests with Postgres, OpenAPI
  drift check, build, Playwright Chromium E2E)

## What is explicitly not built yet

Telemetry ingest, real SDK capture, issue grouping, fingerprinting,
functional pg-boss jobs, source maps, Playwright generator, SSE,
notifications, comments, releases, Ollama analysis, invitations, GitHub OAuth,
CLI secret tokens and public demo mode. No fake SDK snippets, metrics, charts
or screenshots. See `` for the full plan.

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
`.env.example`), plus `NEXT_PUBLIC_REPLAYBUG_API_URL` for the dashboard
(validated once in `apps/web/lib/config.ts`; dev `http://localhost:4001`,
prod reverse-proxy friendly). Startup fails fast with a readable message when
required config is missing.

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
pnpm api:generate        # refresh OpenAPI + typed client (CI checks drift)
pnpm build
node packages/cli/bin/replaybug.js --version
pnpm --filter @replaybug/web test:e2e   # Chromium E2E (needs PG + build)
```

## Monorepo structure

```text
replaybug/
├─ apps/
│  ├─ web/        # Next.js dashboard (auth/onboarding/shell/settings)
│  ├─ api/        # Fastify health + meta + auth/tenancy API
│  ├─ worker/     # Worker lifecycle skeleton (pg-boss registry stub)
│  └─ demo/       # Vite smoke screen (source maps on)
├─ packages/
│  ├─ sdk/            # Browser SDK metadata only
│  ├─ cli/            # replaybug --version/--help
│  ├─ db/             # pg + Drizzle schema/migrations/repos/parsers
│  ├─ contracts/      # Zod health/meta/error + tenancy DTOs
│  ├─ api-client/     # Generated OpenAPI client (openapi-fetch + types)
│  ├─ ui/             # cn + Button (shadcn-compatible base)
│  ├─ observability/  # Pino logger factory
│  └─ config/         # Shared tsconfig presets
├─ docs/
│  ├─ architecture/tenancy.md
│  ├─ architecture/frontend.md
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
