# ADR 0006 — SSE invalidation instead of WebSockets

Status: accepted (Block 6)

## Problem

The dashboard should converge quickly after issue and collaboration changes without
polling aggressively. It needs a browser-friendly authenticated update channel, but
it does not need bidirectional commands or a second source of truth.

## Options considered

1. **Polling.** Simple but creates repeated request load and slower convergence.
   Rejected as the primary live-update mechanism.
2. **WebSockets.** Bidirectional and flexible, but add connection/protocol state that
   is unnecessary for identifier-only invalidation. Rejected.
3. **Server-Sent Events (chosen).** A one-way HTTP stream carries bounded update hints;
   the dashboard refetches canonical REST state using its existing cookie auth.

## Decision

- PostgreSQL `LISTEN/NOTIFY` feeds one API-process broker, which validates payloads
  and fans out `text/event-stream` updates.
- SSE messages contain identifiers and known event types only—never telemetry,
  stacks, comments, credentials, or canonical issue data.
- The client invalidates targeted query keys and refetches through the normal API.
  SSE is an invalidation mechanism, not a state transport or authorization bypass.
- Heartbeats, reconnect backoff, bounded per-subscriber queues, and a degraded state
  keep the dashboard usable when the broker/database stream is unavailable.

## Consequences

- Reuses ordinary HTTP, `EventSource`, and cookie authentication while avoiding a
  WebSocket command protocol.
- Existing streams are not force-revoked on role/session changes; reconnects repeat
  authorization, and streams reveal only change hints. Operators can restart API for
  immediate stream closure.
- The dashboard remains correct without SSE because canonical REST reads and normal
  refetch behavior continue to work.

See [realtime architecture](../architecture/realtime.md) and
[dashboard architecture](../architecture/dashboard.md).
