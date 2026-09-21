# Verification map

This public map connects ReplayBug behavior to executable local checks, API routes,
and durable documentation. It identifies verification surfaces; a listed command or
workflow is not a claim that it has run.

| Verification area                   | Concrete evidence                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository and developer workflow   | [Quick start](../README.md#quick-start); `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e`; [full Docker workflow](self-hosting.md#full-docker-workflow).    |
| Authentication and tenancy          | Local register/login and workspace flows; API authorization integration coverage in `pnpm test`; [tenancy/governance](architecture/tenancy.md) and [frontend](architecture/frontend.md).                                                |
| Projects and credentials            | Project/onboarding routes and origin/key coverage in `pnpm test`; public ingest `POST /api/ingest/v1/batch`; CLI token route `GET /api/v1/cli/project`; [credential ADR](adr/0002-public-ingest-key-versus-secret-token-separation.md). |
| SDK and ingest                      | `pnpm test:sdk`, API ingest suites through `pnpm test`, and demo/browser suites through `pnpm test:e2e`; [SDK usage](../README.md#sdk-and-cli).                                                                                         |
| Processing, issues, and reliability | Real PostgreSQL/pg-boss worker integration coverage in `pnpm test`; `pnpm worker:latency`; [outbox ADR](adr/0001-transactional-outbox-and-pg-boss.md) and [worker design](architecture/worker.md).                                      |
| Source maps                         | Source-map, CLI, and worker suites through `pnpm test` and `pnpm test:e2e`; `replaybug releases create` / `sourcemaps upload`; [source-map design](architecture/source-maps.md).                                                        |
| Dashboard and realtime              | `pnpm --filter @replaybug/web test:e2e`; issue, session, release, metrics, and SSE API routes; [dashboard](architecture/dashboard.md), [frontend](architecture/frontend.md), and [SSE design](architecture/realtime.md).                |
| Reproduction generator              | `pnpm verify:generated-test` plus generator and E2E coverage through `pnpm test` / `pnpm test:e2e`; `POST /api/v1/events/:eventId/reproductions`; [generator design](architecture/reproduction-generator.md).                           |
| Privacy and security                | `pnpm test:sdk`, API security suites through `pnpm test`, and `pnpm test:e2e`; [privacy ADR](adr/0005-privacy-safe-input-defaults.md), [tenancy](architecture/tenancy.md), and `SECURITY.md`.                                           |
| Optional AI                         | `pnpm test` and `pnpm test:e2e` for disabled/configured paths; `GET /api/v1/meta/ai-analysis` and `POST /api/v1/events/:eventId/ai-analyses`; [optional local AI](architecture/ai-analysis.md).                                         |
| Demo and portfolio                  | `pnpm test:e2e`, `pnpm test:browser-compat`, and public-demo `GET /api/v1/public-demo/*`; [`/demo` instructions](../README.md#public-synthetic-demo), [architecture](architecture.md), and [ADRs](adr/README.md).                       |
| Ingest performance                  | `pnpm benchmark:ingest`; [performance notes](performance.md) record only measured local benchmark output.                                                                                                                               |

## Public-demo walkthrough

1. Enable `REPLAYBUG_DEMO_MODE=true`, migrate, and run the explicit `seed-demo`
   profile described in [self-hosting](self-hosting.md#public-demo-opt-in).
2. Open `/demo`, inspect a synthetic issue and occurrence, then follow its session
   timeline. Anonymous public-demo endpoints are `GET` only and bounded.
3. Open the deliberately buggy demo application, trigger a documented error, and
   inspect the grouped/source-mapped evidence in an authenticated local dashboard.
4. Generate/download a reproduction and execute it locally with
   `pnpm verify:generated-test` against a loopback demo target.

## Workflow coverage

The configured [GitHub Actions workflow](../.github/workflows/ci.yml) covers format,
lint, typecheck, test, build, OpenAPI, E2E, browser-compatibility, size, and
dependency-audit gates. The local commands above provide corresponding developer
verification surfaces; workflow run results are recorded by the CI provider.
