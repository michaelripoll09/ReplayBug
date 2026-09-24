# ADR 0002 — Public ingest key versus secret token separation

Status: accepted

## Problem

Two very different callers authenticate against the API:

1. **Browsers** running the SDK, which ship a credential inside public
   JavaScript delivered to every visitor. That credential is visible to
   anyone who opens devtools — it cannot be secret.
2. **CI/automation** (the `replaybug` CLI), which needs a credential
   powerful enough to create releases and upload source maps. That
   credential must be secret and revocable without touching browser code.

One credential cannot serve both: a browser-visible key must be
low-privilege by construction, and a release-management credential must
never ship in a bundle.

## Options considered

1. **Single project key for ingest and CLI.** Simplest, but the CLI
   credential would be extractable from any shipped bundle, and rotating
   it would require redeploying the SDK key everywhere. Rejected.
2. **Dashboard user sessions for the CLI.** Reuses Better Auth cookies,
   but couples automation to a human login, breaks in headless CI, and
   grants the CLI the user's full workspace powers instead of one
   project's automation scope. Rejected.
3. **Separate credential classes (chosen).** A public ingest key
   (`rb_pk_…`) that can only submit telemetry, and a secret project token
   (`rb_sk_…`) that can only drive project-scoped CLI automation —
   different formats, different tables rows (`project_keys` kinds
   `public` vs `secret`), different transports, and neither verifies as
   the other.

## Decision

- **Public ingest key** (`rb_pk_<8hex>_<43b64url>`, 256-bit secret):
  sent in the `x-replaybug-key` header from browsers, gated by exact
  origin matching and PostgreSQL rate limits. It submits telemetry only;
  it can never create releases, upload artifacts, or read anything.
- **Secret project token** (`rb_sk_<8hex>_<43b64url>`, 256-bit secret):
  sent as `Authorization: Bearer` from the CLI. Bearer-only — query
  strings and session cookies are never consulted on CLI routes, keeping
  the token boundary separate from dashboard mutations.
- Both store **prefix + SHA-256 at rest** (never plaintext), verify with
  `timingSafeEqual`, and reject each other's format before any comparison
  runs. Full values are returned exactly once at creation/rotation.
- Secret tokens are **project-scoped principals, never dashboard users**:
  every use re-checks project scope against `project_keys`. Management
  (list/create/revoke) requires the centralized
  `project:manage-secret-tokens` capability (owner/admin only), records
  `last_used_at`, and audits without plaintext/hash material.
- Revocation is immediate; the CLI's next request fails `401`.

## Consequences

- A leaked browser key buys an attacker telemetry submission (still
  origin- and rate-gated) — never releases, uploads, or reads.
- A leaked CLI token is confined to one project's automation and
  revocable without redeploying any SDK key or touching other projects.
- Cost: two credential kinds to document and two verification paths to
  test (the RS-12 security matrix covers cross-kind rejection,
  revoked-token 401s, and log-leak capture proving tokens never reach
  logs).
- The `replaybug` CLI deliberately has no `--token` flag: env-only
  credentials keep tokens out of shell history and process lists. See
  `docs/cli.md`.
