# Architecture Decision Records

ADRs record significant, hard-to-reverse engineering decisions with their
context and consequences. One ADR per file, numbered in order, in
`docs/adr/`.

## Recorded

1. [Transactional outbox with pg-boss](0001-transactional-outbox-and-pg-boss.md)
   — PostgreSQL-backed jobs instead of Redis, plus the outbox handoff and its
   crash window.

## Pending (required by master spec section 47)

The remaining required records are written alongside the blocks that
implement each decision:

2. Semantic timeline instead of DOM/video replay
3. Public ingest key versus secret token separation
4. Privacy-safe input capture defaults
5. SSE instead of WebSockets
6. Local-first artifact storage abstraction
