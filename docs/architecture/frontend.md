# Frontend: Web Auth + Onboarding + Dashboard Shell (Block 3)

Block 3 adds the Next.js dashboard client on top of the Block 2 API. Business
rules stay in Fastify; Next.js is a thin, typed, cookie-forwarding client.
Event ingest, SDK capture, issues, sessions, releases, SSE, notifications,
comments and Ollama remain out of scope.

## Next.js role vs Fastify boundary

```text
Browser (Next.js App Router)
  |-- renders UI, validates input (RHF+Zod), holds one-time secrets in memory
  |-- forwards HttpOnly session cookies (credentials:include, server cookie-forward)
  v
Fastify API (RBAC authority)
  |-- Better Auth sessions, workspaces/projects/envs/origins/keys, audit
  |-- OpenAPI from route schemas -> typed client (no drift)
```

- No business rules in Next.js server actions; no DB access from Next.js.
- No manual cookie decode, no parallel auth, no second permission matrix.
- URL is the source of truth for workspace/project context (`/app/...`).

## Auth client flow

- Official `better-auth` React client v1.7.5 (matching the API), email/password
  only. `baseURL` is the Fastify API URL, `credentials: include`.
- `POST /api/auth/sign-up/email` (register) auto-establishes a session;
  register falls back to an explicit-login prompt if the cookie did not land.
- `POST /api/auth/sign-in/email` (login) distinguishes 401
  ("Invalid email or password") from generic failures + requestId.
- `signOut()` clears the session, then the web clears sensitive TanStack
  cache (`me`, `workspaces`) and redirects to `/login`.
- No auth state in `localStorage`; only the theme uses `localStorage`
  (via `next-themes`).

## Route protection

Server components validate via cookie-forwarding (`lib/auth-server.ts`):

```ts
// forwards `cookie` to GET /api/v1/me, returns user or null
getServerSessionUser();
// redirects to /login when null; no sensitive render before the check
requireServerSession();
```

- `/` smart-redirects: no session -> `/login`; session + no workspace ->
  `/onboarding/workspace`; else first workspace overview.
- `/app/*` layout calls `requireServerSession()` before rendering.
- `/onboarding/*` layout calls `requireServerSession()`; the index route
  consults the backend (workspaces/projects) to route new, partial, and
  configured users.

## Generated client

- `pnpm api:generate` builds the real Fastify instance in-process, calls
  `app.swagger()`, writes `packages/api-client/openapi/openapi.json`
  (marked `x-replaybug-generated`), then runs `openapi-typescript` to
  `src/schema.d.ts` (auto-generated header).
- `createReplayBugApiClient({ baseUrl, fetch })` wraps `openapi-fetch` with
  `credentials: include` and `unwrap()` which throws a normalized `ApiError`
  preserving `{code,message,requestId,details}` with a safe fallback.
- The generator is self-contained: `pnpm api:generate` prepares the
  workspace dependency closure (`^build`) before executing, so it works from
  a clean checkout with no prebuilt `dist/`, no database, and no HTTP
  server.
- CI drift check: `pnpm api:check` (`api:generate` + `git diff --exit-code`
  on both generated files).
- OpenAPI paths: `/api/v1/me`, `/api/v1/workspaces`, `/api/v1/workspaces/:id`,
  `/api/v1/workspaces/:workspaceId/projects`, `/api/v1/projects/:id`,
  `/api/v1/projects/:projectId/environments`, `/api/v1/environments/:id`,
  `/api/v1/projects/:projectId/origins`, `/api/v1/origins/:id`,
  `/api/v1/projects/:projectId/keys`, `/api/v1/projects/:id/keys/public/rotate`,
  plus `/health/*`, `/api/v1/meta`, `/api/auth/*` (Better Auth passthrough).

## Query strategy

TanStack Query factories (`lib/queries.ts`): `me`, `workspaces`, `workspace`,
`projects`, `project`, `environments`, `origins`, `keys`. Stable tuple keys,
`staleTime` 30s, `retry: false`, no polling. Mutations invalidate only the
exact domain key they changed (`useInvalidateDomain`); logout removes
sensitive queries. No global invalidations, no optimistic key rotation.

## URL context

- `/app/workspaces/[workspaceId]` — workspace overview.
- `/app/projects/[projectId]` — project overview.
- `/app/projects/[projectId]/settings[/general|/environments|/origins|/keys]`
  — tabbed settings; the layout loads project + workspace role once and
  provides them via context.
- Onboarding carries ids via search params (`?workspaceId=`, `?projectId=`);
  the wizard context carries only the one-time secret in memory.

## One-time secrets

- Project creation and key rotation return the plaintext key exactly once.
- `OneTimeSecret` (hide/reveal/copy/a11y/monospace) receives the secret as a
  prop; it is never written to `localStorage`/`sessionStorage`/URL/logs/query
  cache/console and disappears on unmount/reload.
- Onboarding holds the secret in wizard context memory; the complete screen
  reports only whether it was acknowledged, never the value.
- Settings rotation drops any previous secret before revealing the new one.
- Key metadata tables show prefix/status/dates only; hashes never reach the
  browser. Verified by grep + manual storage inspection.

## RBAC UX vs backend

UX helpers (`lib/rbac.ts`) map `WorkspaceRole` to affordances only:

| Helper                                                   | owner | admin | member/viewer         |
| -------------------------------------------------------- | ----- | ----- | --------------------- |
| canManageWorkspace                                       | yes   | no    | no                    |
| canCreateProject / canManageProject                      | yes   | yes   | no (hide-or-readonly) |
| canManageEnvironments / canManageOrigins / canRotateKeys | yes   | yes   | no                    |

The backend (`apps/api/src/authz/policy.ts` + `tenancy.integration.test.ts`)
remains the enforcer: member create/rotate -> 403, cross-tenant -> 404.
The UI hides or disables controls that would deterministically 403 and marks
read-only state explicitly; it never grants what the API forbids.

## Theme

`next-themes` (`class` attribute, system default, `suppressHydrationWarning`

- `@custom-variant dark` for Tailwind v4 class-based dark mode). No flash:
  the theme class is applied before paint. Toggle cycles light/dark/system.
  Only the theme uses `localStorage`; secrets never do.

## E2E

Playwright Chromium (`apps/web/e2e/`), isolated by truncating all domain +
auth tables before each test, synthetic `example.com` users only:

1. `onboarding.spec.ts` — register -> workspace -> project (key format
   asserted without logging) -> origin -> complete -> overview -> logout ->
   protected redirect.
2. `login.spec.ts` — wrong creds error, correct login, refresh persists,
   logout, protected blocked.
3. `rbac.spec.ts` — owner sees save/rotate, viewer read-only, direct HTTP
   rotate as viewer -> 403.

Run: `pnpm build` then `pnpm --filter @replaybug/web test:e2e`
(requires Postgres on 5544 + migrations).
