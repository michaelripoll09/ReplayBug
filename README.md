# ReplayBug

Developer observability for reproducible bugs: privacy-safe browser failure
context, grouped issues, session timelines, and Playwright reproduction
tests — on a self-hostable stack with no paid services.

> **Status: Block 9 operations and governance.** Everything from Blocks 7–8
> still holds — and ReplayBug now adds workspace governance and invitations,
> auditable settings, project retention, structured project/workspace deletion
> with durable local-artifact cleanup, and authenticated issue JSON export.
> These are local-first operational features; SMTP delivery, cloud storage,
> hosted execution, billing, SSO, AI analysis, and deployment automation are
> not implemented.

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
  search/filter/sort/keyset pagination, and issue detail with occurrence
  selection, mapped/raw stack evidence, session context, timelines, and
  collaboration controls. Viewer roles are read-only in UI and 403 on direct
  API mutation. See `docs/architecture/dashboard.md` and
  `docs/architecture/realtime.md`.
- Typed dashboard client at `packages/api-client`: `pnpm api:generate`
  prepares its workspace build closure (`turbo` `^build`), builds Fastify
  in-process, writes `openapi/openapi.json` + `src/schema.d.ts`; it is
  fresh-checkout safe (no pre-build, no database, no HTTP server).
  `createReplayBugApiClient({ baseUrl, fetch })` uses `credentials: include`
  with `{code,message,requestId,details}` normalization. `pnpm api:check`
  regenerates and fails on drift; CI runs it.
- Fastify API at `apps/api` with `GET /health/live`, `GET /health/ready`
  (PostgreSQL readiness plus informational `checks.artifactStorage`
  `up|down|unknown` — storage never flips readiness, so ingest survives
  storage outages), `GET /api/v1/meta`, request IDs, contracts-based
  error envelope, and OpenAPI docs in non-production (`/docs`)
- Better Auth email/password at `/api/auth/*` with PostgreSQL persistence,
  HttpOnly + Secure-in-production + SameSite Lax cookies, session rotation,
  strict dashboard CORS with credentials, and `GET /api/v1/me`
- Workspace governance: central `owner|admin|member|viewer` RBAC, member
  management, owner-only ownership transfer and deletion, seven-day one-time
  invitations bound to the recipient email, and paginated sanitized audit logs
  in workspace settings; projects retain their per-workspace slug and have
  owner/admin-managed retention and confirmed deletion
- Browser SDK at `packages/sdk`: automatic exception, unhandled-rejection,
  console-error and failed-request capture, navigation/click/input breadcrumbs,
  privacy-safe defaults, batching, unload flush, retry, size budget
- Public ingest at `apps/api` (`POST /api/ingest/v1/batch`): public-key auth,
  exact origin matching, rate limits with atomic PostgreSQL counters,
  server-side redaction, deterministic truncation, idempotency on
  `(project_id, client_event_id)`, and one transaction per event writing
  session + event + outbox row
- Worker at `apps/worker`: validated config, PostgreSQL health check,
  pg-boss lifecycle, event and reproduction dispatchers, invitation expiry,
  retention cleanup, durable artifact-deletion outbox processing, bounded
  retries, sanitized aggregate logs, and graceful drain on shutdown
- Secret project tokens (`rb_sk_…`, owner/admin managed, one-time reveal,
  immediate revocation) and Bearer-only CLI auth, kept strictly separate
  from public ingest keys and dashboard sessions (see ADR `0002` and
  `docs/cli.md`)
- CLI-managed releases (`replaybug projects info`, `releases create/list`,
  `sourcemaps upload` with preflight skip-existing and conflict abort) and
  release/artifacts APIs with idempotent creates and 409s on conflicting
  identity metadata (see `docs/cli.md`)
- Local artifact storage (`packages/artifacts`, `REPLAYBUG_ARTIFACT_DIR`,
  `replaybug_artifacts` Docker volume): atomic writes, server-generated
  keys, API uploads, and worker reads for symbolication plus deletes for
  durable cleanup; the shared worker mount is writable. Outages degrade
  safely (see `docs/self-hosting.md` and `docs/architecture/source-maps.md`)
- Worker symbolication before fingerprinting (`@jridgewell/trace-mapping`,
  no network, remote `sourceMappingURL` never fetched): mapped stacks by
  default with raw fallback, raw+mapped retention, per-position partial
  mapping, and honest `map_not_found`/`invalid_map`/`storage_unavailable`
  states (see `docs/architecture/source-maps.md`)
- Issue processing: deterministic fingerprinting (exception,
  unhandled rejection, console error, network, message; custom override on
  manual capture), now preferring source-mapped frames so the same
  original source groups into one issue across releases (release stays
  excluded), issue grouping with `UNIQUE (project_id, fingerprint)`,
  occurrence and distinct-session aggregates, first/last seen and
  first/last release (out-of-order safe), regression reopen with activity and
  assignee notification, ignored/investigating semantics, and
  `pg_notify replaybug_project_updates`
- Release/token dashboard: release list/detail (counts, artifact metadata,
  never `storage_key`), secret-token settings with one-time modal, issue
  stacks defaulting to mapped with a Source mapped/Raw toggle
- Occurrence → Playwright reproduction (Block 8): pure generator in
  `packages/reproducer` (plan IR over the last 50 session events,
  semantic navigation/click/input extraction, test_id > role_name >
  label > id > name > css_fallback locator ranking with brittle warnings,
  same-origin route sanitization, sensitive values replaced with
  `REPLACE_WITH_TEST_VALUE` placeholders, `pageerror`/`network`/
  `console_error` failure assertions with bounded `expect.poll`),
  `reproduction_tests` + `reproduction_generation_outbox` tables
  (drizzle `0006`), `POST /api/v1/events/:eventId/reproductions`
  (Idempotency-Key, pre-validates evidence, 202 new / 200 deduped) +
  per-issue history list (no code) + detail + download endpoints, worker
  `replaybug.generate-reproduction` queue with dispatcher and deterministic
  ready/failed completion, dashboard panel (generate/copy/download/
  regenerate/history, viewer read-only), and a verified demo-generated
  test (`demo-uncaught-error` pageerror scenario passes locally via
  `scripts/verify-generated-test.ts`, loopback-only). See
  `docs/architecture/reproduction-generator.md`
- Issue JSON export: an authenticated, single-issue download with allowlisted
  issue data, an optional retained occurrence, raw/mapped stack views, bounded
  timeline, and safe reproduction summaries (never telemetry payloads, comment
  bodies, reproduction code, or secrets)
- Real Drizzle versioned migrations through `0007_thin_omega_sentinel.sql`,
  with empty-database and upgrade-boundary migration tests; dev-only seed
  (`pnpm db:seed`) creates demo tenancy only
- PostgreSQL 17 via Docker Compose with healthcheck and persistent volume
- GitHub Actions CI runs format, lint, typecheck, tests with PostgreSQL on
  5544 plus hermetic temp-dir artifact storage, OpenAPI drift check, build,
  and Chromium E2E. Block 9 governance, retention, deletion, and export
  behavior is covered by focused unit/integration tests; this is not a claim
  of arbitrary remote execution or deployment coverage

## What is explicitly not built yet

SMTP invitation delivery, S3/object storage, Redis, billing, SSO, GitHub OAuth,
Ollama or other AI analysis, hosted execution, public demo mode, and deployment
automation are not built. Generated tests run locally by the developer.
Docker Compose runs PostgreSQL by default; it is not a one-command production
full-stack deployment. No fake metrics, charts, or screenshots.
See `docs/architecture/worker.md` and `docs/self-hosting.md` for the current
operational boundaries.

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
`5544->5432` with healthcheck and persistent volume. Release artifacts live
in the `replaybug_artifacts` named volume (container path
`/var/lib/replaybug/artifacts`, dev default `~/.replaybug/artifacts` via
`REPLAYBUG_ARTIFACT_DIR`); back it up alongside the database (see
`docs/self-hosting.md`). Migrations are
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
pnpm api:generate        # refresh OpenAPI + typed client (builds its dep closure)
pnpm api:check           # regenerate + fail on drift (what CI runs)
pnpm build
pnpm sdk:size            # SDK bundle size budget
node packages/cli/bin/replaybug.js --version
pnpm --filter @replaybug/web test:e2e   # dashboard Chromium E2E (needs PG + build)
pnpm test:e2e            # web E2E + demo ingest E2E + demo worker E2E
pnpm worker:latency      # reproducible processing-latency smoke (needs build + PG)
```

`pnpm api:generate` is self-contained: it prepares the workspace dependency
closure before generating, so a fresh checkout only needs
`pnpm install --frozen-lockfile` first — no `pnpm build`, no database, no
HTTP server.

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
│  ├─ cli/            # replaybug CLI (projects/releases/sourcemaps, secret-token auth)
│  ├─ artifacts/      # ArtifactStorage seam + local backend + path/key policy
│  ├─ db/             # pg + Drizzle schema/migrations/repos/fingerprinting
│  ├─ reproducer/     # pure occurrence→Playwright generator (no I/O)
│  ├─ contracts/      # Zod telemetry protocol + tenancy DTOs + reproductions
│  ├─ api-client/     # Generated OpenAPI client (openapi-fetch + types)
│  ├─ ui/             # cn + Button (shadcn-compatible base)
│  ├─ observability/  # Pino logger factory
│  └─ config/         # Shared tsconfig presets
├─ docs/
│  ├─ architecture.md            # architecture index
│  ├─ architecture/source-maps.md
│  ├─ architecture/reproduction-generator.md
│  ├─ architecture/tenancy.md
│  ├─ architecture/frontend.md
│  ├─ architecture/worker.md
│  ├─ architecture/fingerprinting.md
│  ├─ cli.md                     # CLI reference
│  ├─ self-hosting.md            # artifact storage operations
│  ├─ specs/replaybug-master-spec.md
│  └─ adr/
├─ scripts/           # seed-dev, worker-latency-smoke, verify-generated-test
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
