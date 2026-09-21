# Acceptance map

This is a concise proof map for the master
[Definition of Done](specs/replaybug-master-spec.md#65-definition-of-done). It maps
its section-level requirements to executable local evidence, routes, and durable
documentation. A command listed here is a proof surface, not an invented pass result.

| Definition of Done area             | Concrete proof surface                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository and developer experience | Fresh-clone sequence in [README](../README.md#quick-start); `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`; [full Docker workflow](self-hosting.md#full-docker-workflow). |
| Authentication and tenancy          | Local register/login and workspace flows; API authorization integration tests in `pnpm test`; [tenancy/governance](architecture/tenancy.md) and [frontend](architecture/frontend.md).                                                               |
| Projects and credentials            | Project/onboarding routes and origin/key tests in `pnpm test`; public ingest `POST /api/ingest/v1/batch`; CLI token route `GET /api/v1/cli/project`; [credential ADR](adr/0002-public-ingest-key-versus-secret-token-separation.md).                |
| SDK and ingest                      | `pnpm test:sdk`, API ingest suites through `pnpm test`, and the demo/browser suites through `pnpm test:e2e`; SDK snippet in [README](../README.md#sdk-and-cli).                                                                                     |
| Processing and issues               | Real PostgreSQL/pg-boss worker integration suites in `pnpm test`; [outbox ADR](adr/0001-transactional-outbox-and-pg-boss.md) and [worker design](architecture/worker.md).                                                                           |
| Source maps                         | `pnpm test` source-map/CLI/worker suites and `pnpm test:e2e`; `replaybug releases create` / `sourcemaps upload`; [source-map design](architecture/source-maps.md).                                                                                  |
| Dashboard                           | `pnpm --filter @replaybug/web test:e2e`; issue, session, release, metrics, and SSE API routes; [dashboard](architecture/dashboard.md), [frontend](architecture/frontend.md), and [SSE design](architecture/realtime.md).                            |
| Reproduction generator              | `pnpm verify:generated-test` plus generator and E2E coverage under `pnpm test` / `pnpm test:e2e`; `POST /api/v1/events/:eventId/reproductions`; [generator design](architecture/reproduction-generator.md).                                         |
| Privacy and security                | `pnpm test:sdk`, API security suites through `pnpm test`, and `pnpm test:e2e`; [privacy ADR](adr/0005-privacy-safe-input-defaults.md), [tenancy](architecture/tenancy.md), and `SECURITY.md`.                                                       |
| Worker and reliability              | `pnpm test` real PostgreSQL/pg-boss integration coverage and `pnpm worker:latency`; [worker operations](architecture/worker.md).                                                                                                                    |
| Optional AI                         | `pnpm test` and `pnpm test:e2e` cover disabled/configured paths; `GET /api/v1/meta/ai-analysis` and `POST /api/v1/events/:eventId/ai-analyses`; [optional local AI](architecture/ai-analysis.md).                                                   |
| Demo and portfolio                  | `pnpm test:e2e`, `pnpm test:browser-compat`, and public-demo `GET /api/v1/public-demo/*`; [`/demo` instructions](../README.md#public-synthetic-demo), [architecture](architecture.md), [ADRs](adr/README.md), and this map.                         |

## Public-demo walkthrough

1. Enable `REPLAYBUG_DEMO_MODE=true`, migrate, and run the explicit `seed-demo`
   profile described in [self-hosting](self-hosting.md#public-demo-opt-in).
2. Open `/demo`, inspect a synthetic issue and occurrence, then follow its session
   timeline. Anonymous public-demo endpoints are `GET` only and bounded.
3. Open the deliberately buggy demo application, trigger a documented error, and
   inspect the grouped/source-mapped evidence in an authenticated local dashboard.
4. Generate/download a reproduction and execute it locally with
   `pnpm verify:generated-test` against a loopback demo target.

## CI status

**Pending only:** remote GitHub Actions for `feat/final-portfolio` have not run because
this branch has not been pushed. The declared remote gates are documented in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); their local command
equivalents are listed above. No other remote proof is implied by this status.
