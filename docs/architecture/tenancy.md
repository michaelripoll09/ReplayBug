# Tenancy, Auth and Project Credentials (Block 2)

Block 2 implements authentication, workspace tenancy, projects, environments,
origins and public ingest keys. Event ingest, SDK capture, issues, jobs,
SSE, releases and dashboard UI are explicitly out of scope.

## Tenancy diagram

```text
User (Better Auth: user/session/account/verification)
  |
  | 1 user -> N memberships
  v
Membership (workspace_id + user_id unique, role owner|admin|member|viewer)
  |
  | N memberships -> 1 workspace
  v
Workspace (id UUID opaque, slug globally unique, created_by FK)
  |
  | 1 workspace -> N projects
  v
Project (workspace + slug unique, timezone default UTC, retention 30 default 7-365)
  |
  +-> Environments (project + name unique, single default invariant)
  +-> Origins (project + origin unique, ORIGIN-only, no wildcards)
  +-> Keys (prefix unique, hash at rest, one-time plaintext)
  +-> Audit logs (append-only, workspace scope, project nullable)
```

## Roles and capabilities

Central policy only (`apps/api/src/authz/policy.ts`); no scattered `if (role)`
checks. Project access derives from workspace membership; there is no
project-membership system.

| Capability            | owner | admin | member | viewer |
| --------------------- | ----- | ----- | ------ | ------ |
| workspace:read        | yes   | yes   | yes    | yes    |
| workspace:update      | yes   | no    | no     | no     |
| project:create/read   | yes   | yes   | read   | read   |
| project:update/delete | yes   | yes   | no     | no     |
| environment:read      | yes   | yes   | yes    | yes    |
| environment:write     | yes   | yes   | no     | no     |
| origin:read           | yes   | yes   | yes    | yes    |
| origin:write          | yes   | yes   | no     | no     |
| key:read              | yes   | yes   | yes    | yes    |
| key:rotate            | yes   | yes   | no     | no     |

Cross-tenant reads return `NOT_FOUND` (anti-enumeration), not `FORBIDDEN`.

## Auth

- Better Auth email/password with PostgreSQL persistence (`user`, `session`,
  `account`, `verification`). No parallel users table; domain FKs reference
  `user.id` directly.
- No OAuth and no fake password reset this block.
- Cookies: HttpOnly, Secure in production, SameSite Lax, rotation via
  `updateAge` (24h) and 7-day expiry.
- Strict dashboard CORS with credentials; Better Auth CSRF never disabled.
- Config boundary: `REPLAYBUG_AUTH_SECRET` (min 32), `REPLAYBUG_API_URL`,
  `REPLAYBUG_WEB_URL`, `REPLAYBUG_TRUSTED_ORIGINS`, `NODE_ENV`.

## Public keys are FUTURE write-only, ingest not built

- Format: `rb_pk_<prefix>_<secret>` where prefix is 8 hex chars (lookup/display,
  not secret) and secret is 32 CSPRNG bytes base64url (256-bit).
- Stored as `prefix` + `sha256(fullKey)` hex; verified with `timingSafeEqual`.
  Plaintext is returned ONE time at creation/rotation and never re-displayed.
- Rotation revokes old actives and creates a new key in one transaction; old
  rows are retained auditable.
- `project POST` returns a `bootstrap` section with the one-time key, prefix,
  projectId and an explicitly FUTURE ingest endpoint marked non-functional.
- Allowed origins are ORIGIN-only (scheme + host + port, no path/query/fragment),
  http/https only, no `*` wildcards. `http://localhost:<port>` must be explicit
  (never `http://localhost:*`) and is dev-only by policy.
- Environment `base_url` allows http/https with optional path; rejects
  `javascript:`, `file:`, `data:`.
- Audit actions: `workspace.created/updated`, `project.created/updated/deleted`,
  `project_origin.created/updated/deleted`, `project_key.rotated`. Metadata is
  sanitized; no plaintext keys, cookies or passwords are stored.

## Transactions

- Create workspace = workspace + owner membership + audit in ONE transaction.
- Create project = project + `production` env (default) + initial key + audit in
  ONE transaction.
- Rotate key = revoke old + create new + audit in ONE transaction.
- Delete project is transactional and idempotent; audit row survives with
  `project_id` set to null.
- Single default environment is enforced by a partial unique index plus service
  logic; deleting the default promotes the smallest remaining name; the last
  environment cannot be deleted.
