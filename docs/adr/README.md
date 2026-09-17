# Architecture Decision Records

ADRs record significant, hard-to-reverse engineering decisions with their
context and consequences.

## Current state (foundation)

No ADRs are recorded yet. The master specification (section 47) requires, at
minimum, records for:

1. Semantic timeline instead of DOM/video replay
2. PostgreSQL-backed jobs instead of Redis
3. Public ingest key versus secret token separation
4. Privacy-safe input capture defaults
5. SSE instead of WebSockets
6. Local-first artifact storage abstraction

These will be written alongside the blocks that implement each decision.
