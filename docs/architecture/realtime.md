# Realtime — SSE Invalidation via PostgreSQL LISTEN/NOTIFY

> Covers the server broker, web client, and end-to-end behavior.

## Path

```text
worker / API mutation ──(in-tx pg_notify)──▶ PostgreSQL
                                                  │ LISTEN replaybug_project_updates
                                                  ▼ (one connection per API process)
                                          API broker (validate → fan-out in-memory)
                                                  │ SSE text/event-stream
                                                  ▼
                                          dashboard (invalidates TanStack Query,
                                                     refetches canonical state)
```

## Design decisions

- **Process-level single LISTEN** (`apps/api/src/realtime/broker.ts`):
  one dedicated `pg` Client per API process. Dedicated, because LISTEN
  needs a connection that never runs transactional business queries.
  Lazy: connects on the first stream subscriber; stays up for process
  lifetime; `stop()` on app close. Reconnects with capped backoff
  (1s → 30s) on error/end.
- **Validate, then fan out**: every payload is JSON-parsed and
  shape-checked (`version: 1`, known type, UUID ids). Anything else is
  dropped with a warning — never forwarded, never thrown. Only
  `{version, type, projectId, issueId, eventId?}` crosses the stream:
  no telemetry, stacks, comments, payloads or secrets.
- **Event types**: `issue.created | issue.updated | issue.regressed`
  (worker) + `comment.created | assignment.changed | tags.changed`
  (dashboard mutations, no `eventId` — there is no telemetry event).
- **SSE is invalidation, not source of truth**: receivers refetch via
  TanStack Query. The stream carries change hints only.
- **Heartbeat**: `: heartbeat` comment every 25s, no DB traffic.
- **Backpressure**: per-subscriber bounded queue (50). Overflow coalesces
  to the latest update (correct for invalidation semantics). Sinks that
  throw (dead sockets) are unsubscribed; socket close always cleans up
  (unsubscribe + clear heartbeat), so no listener leaks.
- **Ready gate**: the `ready` frame is sent after LISTEN is established,
  so every mutation after `ready` is observable. If the database is
  unreachable the stream still opens with `status: "degraded"` — the
  dashboard keeps working through normal refetch (degraded operation).

## Authorization

- Checked **at connect**: cookie session → project lookup → workspace
  membership (`requireProjectAccess`, anti-enumeration NOT_FOUND) →
  `issue:read` capability. Anonymous → 401, foreign project → 404,
  under-privileged → 403.
- Every **reconnect re-runs** the handler: a new HTTP connection means a
  fresh auth check.

## Revocation note (mandate)

SSE connections are long-lived bearer connections: **revoking a session,
removing a member, or downgrading a role does not kill already-open
streams**. Mitigations, in order:

1. Clients reconnect with backoff on any drop; each reconnect re-checks
   auth, so revocation takes effect at the next connection.
2. All state-changing and data endpoints re-authorize per request —
   a revoked stream can at most receive change _hints_ (ids only), never
   data, and its refetches will 401/404.
3. Operators needing immediate effect restart the API process (single
   LISTEN per process; all streams re-establish and re-authorize).

This matches the threat model: stream payloads contain no sensitive data
by construction, so a lingering stream leaks nothing beyond "something
changed in a project the user could recently see".

## Web client

- `apps/web/lib/realtime.ts` — `createProjectEventStream`: validated URL
  (http(s)/same-origin only, UUID project), typed parse + validation of
  `project-update` frames (foreign/malformed dropped), deterministic
  capped-backoff reconnect (1s→30s), status
  (`connecting/connected/degraded/reconnecting/closed`), idempotent
  `close()` cleanup. Native `EventSource` with `withCredentials` (cookie
  auth), separate from `openapi-fetch`.
- **Named-event gotcha (found by E2E)**: the server sends named frames
  (`event: ready`, `event: project-update`), which dispatch to
  `addEventListener` listeners — `onmessage` only sees unnamed frames.
  The first client listened via `onmessage` only and was deaf in browsers
  (Node-fetch tests passed because they parse frames manually). The helper
  now subscribes to both names plus an unnamed fallback.
- `apps/web/lib/use-realtime.ts` — `useProjectRealtime(projectId)`:
  one stream per mounted project scope; maps update types to targeted
  TanStack Query prefix invalidations (detail/list/metrics/comments/
  activity/tags); cleanup on unmount/project change.
- `RealtimeStatus` shows the honest state: Live / Reconnecting… /
  Connected (degraded) / Connecting… — never fake-live.
