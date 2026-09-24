# Architecture Decision Records

ADRs record significant, hard-to-reverse engineering decisions with their
context and consequences. One ADR per file, numbered in order, in
`docs/adr/`.

## Recorded

1. [Transactional outbox with pg-boss](0001-transactional-outbox-and-pg-boss.md)
   — PostgreSQL-backed jobs instead of Redis, plus the outbox handoff and its
   crash window.
2. [Public ingest key versus secret token separation](0002-public-ingest-key-versus-secret-token-separation.md)
   — `rb_pk_…` browsers vs `rb_sk_…` CLI automation, separate formats,
   transports, and privilege.
3. [Local-first artifact storage abstraction](0003-local-first-artifact-storage-abstraction.md)
   — filesystem-backed `ArtifactStorage` seam and server-generated keys; the
   2025-07-16 lifecycle update supersedes worker-read-only access so the worker
   reads for symbolication and deletes durable cleanup artifacts from a
   writable shared mount.
4. [Semantic timeline instead of DOM/video replay](0004-semantic-timeline-over-video-replay.md)
   — bounded, privacy-conscious interaction evidence that can support a
   deterministic reproduction.
5. [Privacy-safe input capture defaults](0005-privacy-safe-input-defaults.md)
   — input values are opt-in, redacted defensively, and rendered as test-value
   placeholders when a reproduction needs one.
6. [SSE invalidation instead of WebSockets](0006-sse-over-websockets.md)
   — identifier-only live-update hints over SSE, with REST as the canonical
   source of truth.
