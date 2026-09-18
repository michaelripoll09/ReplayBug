# ReplayBug

Developer observability for reproducible bugs: privacy-safe browser failure
context, grouped issues, session timelines, and Playwright reproduction
tests — on a self-hostable stack with no paid services.

> **Status: Block 6 issues dashboard.** Auth, tenancy, onboarding,
> dashboard shell, settings, typed OpenAPI client, Chromium E2E, the browser
> SDK, public ingest, and the asynchronous processing pipeline (transactional
> outbox → pg-boss → normalization → deterministic fingerprinting → issue
> grouping → aggregates → regression handling → PostgreSQL NOTIFY) exist with
> real PostgreSQL — **and** the issue workflow API + dashboard now consume
> them: issue list/detail/occurrences with search/filter/sort/pagination,
> project metrics, status/assignment/tags/comments/activity, sessions and
> timelines, notifications, and SSE realtime invalidation. Source maps,
> releases, Playwright reproduction generation, retention cleanup and
> Ollama analysis are explicitly not built yet.

## What exists today

- pnpm workspaces + Turborepo monorepo (`apps/*`, `packages/*`)
- Next.js dashboard at `apps/web`: smart `/` redirect, `/login`, `/register`
  (email/password, no OAuth), `/onboarding[/workspace|/project|/origin|/complete]`
  wizard, `/app/workspaces/[workspaceId]` and `/app/projects/[projectId]`
  overviews (live metrics where telemetry exists),
  `/app/projects/[projectId]/settings[/general|/environments|/origins|/keys]`
  with RBAC hide-or-readonly, sidebar + workspace switcher + theme
  (light/dark/system, no flash) + mobile drawer. See
  `docs/architecture/frontend.md`.
- Dashboard issues workflow (Block 6): project overview with Recharts
  metrics (`?range=24h|7d|30d`), issue list with URL-driven
  search/filter/sort/keyset pagination, issue detail with occurrence
  selector (`?event=`), raw-stack-as-text evidence, embedded session
  context and full session timelines, status/assignment/tags/comments with
  activity history, sessions list/detail, notifications bell, and SSE
  invalidation with honest Live/Reconnecting status. Viewer roles are
  read-only in UI and 403 on direct API mutation. No reproduction
  generation, AI panels, or source-mapped frames exist yet — none are
  shown. See `docs/architecture/dashboard.md` and
  `docs/architecture/realtime.md`.
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
- Browser SDK at `packages/sdk`: automatic exception, unhandled-rejection,
  console-error and failed-request capture, navigation/click/input breadcrumbs,
  privacy-safe defaults, batching, unload flush, retry, size budget
- Public ingest at `apps/api` (`POST /api/ingest/v1/batch`): public-key auth,
  exact origin matching, rate limits with atomic PostgreSQL counters,
  server-side redaction, deterministic truncation, idempotency on
  `(project_id, client_event_id)`, and one transaction per event writing
  session + event + outbox row
- Worker at `apps/worker`: validated config, PostgreSQL health check,
  pg-boss lifecycle, `replaybug.process-event` consumer, transactional outbox
  dispatcher (`FOR UPDATE SKIP LOCKED`), reconciliation loop, bounded retries,
  poison-job visibility, graceful shutdown
- Issue processing: deterministic fingerprinting (exception,
  unhandled rejection, console error, network, message; custom override on
  manual capture), issue grouping with `UNIQUE (project_id, fingerprint)`,
  occurrence and distinct-session aggregates, first/last seen and
  first/last release (out-of-order safe), regression reopen with activity and
  assignee notification, ignored/investigating semantics, and
  `pg_notify replaybug_project_updates`
- Real Drizzle versioned migrations (`packages/db/drizzle`) and dev-only seed
  (`pnpm db:seed`: demo user/workspace/project/prod env/dev env/localhost origin)
- PostgreSQL 17 via Docker Compose with healthcheck and persistent volume
- GitHub Actions CI (format, lint, typecheck, tests with PostgreSQL, OpenAPI
  drift check, build, Playwright Chromium E2E including the worker E2E)

## What is explicitly not built yet

Release management and source maps (stacks render raw/unsymbolicated),
Playwright reproduction generator, retention cleanup, invitation cleanup,
Ollama analysis, GitHub OAuth, CLI secret tokens and public demo mode.
Fingerprinting runs on raw sanitized stacks until source maps exist, so
minified frames group by minified location. No fake metrics, charts or
screenshots. See `` for the full
plan and `docs/architecture/worker.md` for what the worker does today.

## Stack

Node.js 24, TypeScript (strict), pnpm workspaces, Turborepo, Next.js (App
Router) + React + Tailwind CSS, Fastify + Zod, PostgreSQL 17, Drizzle ORM,
pg-boss (job queue on PostgreSQL), Pino, Vitest, Vite, Playwright. No Redis.
No paid services.

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
pnpm db:migrate             # needs REPLAYBUG_DATABASE_URL in the environment
pnpm db:seed                # dev-only; DEMO/LOCAL ONLY creds, no telemetry data
pnpm dev
```

`pnpm dev` also starts the worker, so telemetry accepted by the demo app is
processed into issues locally. Watch the worker logs for
`process-event completed` lines. To inspect the pipeline manually:
`pnpm --filter @replaybug/worker start` (after `pnpm build`).

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
pnpm sdk:size            # SDK bundle size budget
node packages/cli/bin/replaybug.js --version
pnpm --filter @replaybug/web test:e2e   # dashboard Chromium E2E (needs PG + build)
pnpm test:e2e            # web E2E + demo ingest E2E + demo worker E2E
pnpm worker:latency      # reproducible processing-latency smoke (needs build + PG)
```

`pnpm test` includes the worker integration suites (real PostgreSQL, real
pg-boss): event→issue creation, grouping, concurrency, regression, retries,
poison jobs, crash-window dedupe and worker restart. `pnpm test:e2e` runs the
demo suite twice: ingest/privacy with the worker down (events stay pending and
dispatched-safe) and the worker suite with the real worker process
(browser → SDK → ingest → outbox → pg-boss → worker → issue).

## Monorepo structure

```text
replaybug/
├─ apps/
│  ├─ web/        # Next.js dashboard (auth/onboarding/shell/settings)
│  ├─ api/        # Fastify auth/tenancy API + public telemetry ingest
│  ├─ worker/     # Outbox dispatcher, pg-boss consumer, issue processing
│  └─ demo/       # Deliberately buggy Vite app + Chromium E2E suites
├─ packages/
│  ├─ sdk/            # Browser SDK (capture, batching, privacy defaults)
│  ├─ cli/            # replaybug --version/--help
│  ├─ db/             # pg + Drizzle schema/migrations/repos/fingerprinting
│  ├─ contracts/      # Zod telemetry protocol + tenancy DTOs
│  ├─ api-client/     # Generated OpenAPI client (openapi-fetch + types)
│  ├─ ui/             # cn + Button (shadcn-compatible base)
│  ├─ observability/  # Pino logger factory
│  └─ config/         # Shared tsconfig presets
├─ docs/
│  ├─ architecture.md            # architecture index
│  ├─ architecture/tenancy.md
│  ├─ architecture/frontend.md
│  ├─ architecture/worker.md
│  ├─ architecture/fingerprinting.md
│  ├─ specs/replaybug-master-spec.md
│  └─ adr/
├─ scripts/           # seed-dev, worker-latency-smoke
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
