# Tenancy, Governance and Project Lifecycle

ReplayBug uses Better Auth users and workspace memberships. Project access derives
from the workspace; there is no project-membership system.

## Tenancy diagram

```text
User (Better Auth)
  -> Membership (workspace_id + user_id unique; one owner)
  -> Workspace (globally unique slug)
  -> Project (workspace + slug unique; timezone; retention_days 7–365)
     -> telemetry, issues, reproductions, releases, artifact metadata
```

Workspace-scoped audit records are append-only while the workspace exists.

## Roles and governance

Roles are ordered `owner > admin > member > viewer`; the central policy in
`apps/api/src/authz/policy.ts` is authoritative. All roles can read their
workspace and project evidence. Owners manage workspace settings, transfer
ownership, and delete a workspace. Owners and admins manage projects,
environments, origins, keys, invitations, and members within the policy;
members have ordinary project read access; viewers are read-only.

There is exactly one owner. The owner cannot be removed or leave. Ownership
transfer is an owner-only, locked transaction to an existing non-owner member:
the former owner becomes admin and the target becomes the sole owner. Role
mutation cannot create another owner, and the last-owner invariant is checked
before membership changes. Cross-tenant access is `NOT_FOUND`, not `FORBIDDEN`.

## Invitations

Owners may invite `admin`, `member`, or `viewer`; admins may invite only
`member` or `viewer`. An invitation never grants ownership. Email addresses are trimmed and lowercased for storage
and comparison. Creation returns the opaque `rb_inv_...` token and invite URL
once; ReplayBug does not send email or implement SMTP delivery.

Only a SHA-256 hash of the complete token and its non-secret prefix are stored.
Tokens contain 256 bits of CSPRNG secret material, are verified with a
constant-time comparison, expire seven days after creation, and are bound to
the currently authenticated user's normalized email. Acceptance locks the
invitation and membership state, creates the membership only when the recipient
is not already a member, and marks the invitation accepted. Replayed, revoked,
expired, wrong-email, and already-member attempts do not grant access.

At most one active pending invitation exists for a workspace/email pair.
Revocation and the worker's expired-invitation cleanup retire pending entries;
historical metadata remains listable to authorized administrators, but tokens
and token hashes never enter DTOs or audit metadata.

## Audit access

Governance and project-lifecycle actions write sanitized, bounded metadata and
a safe actor identity. No plaintext keys, invitation tokens, credentials,
cookies, telemetry payloads, or arbitrary JSON are stored or rendered.

The workspace settings audit view requires audit-read capability and offers an
action filter plus newest-first keyset pagination on `(created_at, id)`, with a
maximum page size of 100. Cursors are opaque and invalid cursors fail validation.
The UI summarizes allowlisted scalar metadata rather than rendering arbitrary
metadata values.

## Retention

Each project has `retention_days` from 7 through 365. The worker compares UTC
`timestamptz` values to the project-specific cutoff
`now - retention_days * interval '1 day'`; it does not use browser or workspace
local time.

A pass is one bounded transaction. It selects oldest eligible events and
sessions in stable order using `FOR UPDATE SKIP LOCKED`, rechecks mutable
conditions under the lock, then deletes at most the configured batch. Eligible
events are processed or rejected, older than the cutoff, have no undispatched
event outbox entry, and have no pending reproduction. This removes raw event
payload/evidence only after work that needs it is safe.

Issue lifetime counters, issue activity and comments, completed/failed
reproduction history, and issue rows remain. `issue_affected_sessions` also
remains: it is the lifetime distinct-session deduplication key, so a telemetry
session referenced by it may outlive raw-event retention. A session is deleted
only after its cutoff when it has no events and no affected-session relation.
Pending events and pending reproductions are protected rather than expired.

## Confirmed deletion and local artifacts

Project and workspace deletion requires the current slug exactly, including
case; normalized or case-folded confirmation is rejected. The API locks the
target, checks authorization and confirmation, validates every release artifact
against its canonical storage key, enqueues those keys in the durable
artifact-deletion outbox, writes lifecycle audit records, and only then performs
the relational cascade in the same transaction.

The outbox has a unique storage key, so repeated or overlapping cascades are
idempotent. The worker claims bounded pending rows with `FOR UPDATE SKIP LOCKED`,
deletes files from the local filesystem, and marks completion. Failures remain
retryable; a crash after unlink and before completion is safe because a missing
local file counts as deleted on retry.

Project audit rows survive project deletion with `project_id = NULL`. Workspace
audit history does **not** survive workspace deletion: workspace deletion
cascades its audit rows, including the deletion-requested and deletion-completed
rows. This is the current behavior, not durable historical workspace audit.

See [Worker](worker.md) for runners and configuration, and
[Self-hosting](../self-hosting.md) for shared-directory operations.

## Auth and credentials

Better Auth supports email/password with PostgreSQL persistence, HttpOnly
cookies, Secure-in-production and SameSite Lax settings. GitHub OAuth is
optional and is enabled only when `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are configured together. ReplayBug has no enterprise
SSO or billing integration. Public ingest keys, CLI secret Bearer tokens, and
browser/dashboard sessions remain separate credential classes; ingest keys are
shown in plaintext only at creation or rotation and are hashed at rest.
