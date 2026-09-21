# Frontend: Web Auth + Operations Dashboard (Block 9)

The Next.js dashboard is a thin, typed, cookie-forwarding client for the
Fastify API. By Block 9 it covers onboarding, project operations, issue
investigation, and workspace governance; Fastify remains the authority for
business rules and RBAC.

## Next.js role vs Fastify boundary

```text
Browser (Next.js App Router)
  |-- renders UI, validates input (RHF+Zod), holds one-time secrets in memory
  |-- forwards HttpOnly session cookies (credentials:include, server cookie-forward)
  v
Fastify API (auth, data, and RBAC authority)
  |-- Better Auth sessions, governance, project lifecycle, and observability APIs
  |-- OpenAPI from route schemas -> typed client (no drift)
```

- No business rules in Next.js server actions, no database access, no manual
  cookie decoding, and no second permission matrix.
- The URL is the source of truth for workspace and project context.
- The client hides or disables deterministically forbidden actions, but direct
  API requests remain subject to Fastify authorization.

## Auth and generated client

- The official `better-auth` React client uses the Fastify API URL and
  `credentials: include`; email/password registration establishes a session
  and login reports authentication failures separately from generic errors.
- Server components forward the cookie to `GET /api/v1/me`; `/app/*` and
  `/onboarding/*` require a session before sensitive UI renders. `/` routes a
  signed-in user to the appropriate onboarding or workspace view.
- `pnpm api:generate` builds the Fastify dependency closure in-process,
  writes the OpenAPI document and generated schema, and needs neither a
  database nor an HTTP server. `pnpm api:check` regenerates and fails on
  drift.

## Routes and dashboard experience

- Project routes cover the overview, URL-driven issue list, issue detail,
  sessions, releases, and project settings. Issue detail combines occurrence
  selection, mapped/raw stack views, timeline context, status, assignment,
  tags, comments, reproduction controls, and authenticated JSON export.
- Workspace routes include the overview and settings tabs for **Members**,
  **Invitations**, **Audit**, and **Danger Zone**.
- Project general settings show retention as either lifetime or retained data,
  and require explicit confirmation for project deletion. Workspace danger
  actions similarly require confirmation for ownership transfer or deletion.

## Query and live-update strategy

TanStack Query uses stable domain keys, a 30-second `staleTime`, no polling,
and `retry: false`. Mutations invalidate only the affected domain; logout
removes sensitive queries. SSE and notification updates invalidate the
specific affected project, issue, session, release, or notification keys—never
the entire cache. This preserves backend authority while keeping live status
honest during reconnects.

## One-time values

- Project creation and key rotation reveal plaintext keys once. `OneTimeSecret`
  keeps them in component or wizard memory, never browser storage, URLs, logs,
  query cache, or the console.
- Creating an invitation reveals its invitation URL once. The UI does not
  retain or reconstruct it after dismissal; later lists expose only safe
  invitation metadata.

## Governance RBAC UX

| Action                                           | Owner                    | Admin                    | Member / viewer |
| ------------------------------------------------ | ------------------------ | ------------------------ | --------------- |
| Invite users                                     | admin, member, or viewer | member or viewer         | no              |
| Manage invitations and members; read audit       | yes                      | yes                      | no              |
| Change member/viewer roles or remove them        | yes                      | limited to member/viewer | no              |
| Transfer workspace ownership or delete workspace | yes                      | no                       | no              |
| Set project retention or delete a project        | yes                      | yes                      | no              |

The backend enforces this central capability policy. The frontend represents
read-only state explicitly instead of treating visibility as authorization.

## Theme and verification

`next-themes` applies the light, dark, or system class before paint; only the
theme uses `localStorage`. Playwright coverage exercises authentication and
onboarding, project settings and issue workflows, viewer read-only behavior,
and governance confirmation paths. Browser storage is inspected to ensure
one-time values are not persisted.

The separate `pnpm test:browser-compat` demo/SDK smoke runs only on Playwright
Chromium, Firefox, and WebKit; it does not multiply the dashboard suite across
browsers. Edge is not a separate project because its rendering engine is
Chromium, while WebKit provides Safari-engine coverage.
