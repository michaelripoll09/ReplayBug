# Architecture Decision Records

ADRs record significant, hard-to-reverse engineering decisions with their
context and consequences. One ADR per file, numbered in order, in
`docs/adr/`.

## Recorded

1. [Transactional outbox with pg-boss](0001-transactional-outbox-and-pg-boss.md)
   — PostgreSQL-backed jobs instead of Redis, plus the outbox handoff and its
   crash window (master spec §47 topic 2).
2. [Public ingest key versus secret token separation](0002-public-ingest-key-versus-secret-token-separation.md)
   — `rb_pk_…` browsers vs `rb_sk_…` CLI automation, separate formats,
   transports, and privilege (master spec §47 topic 3).
3. [Local-first artifact storage abstraction](0003-local-first-artifact-storage-abstraction.md)
   — filesystem-backed `ArtifactStorage` seam and server-generated keys;
   Block 9 supersedes worker-read-only access so the worker reads for
   symbolication and deletes durable cleanup artifacts from a writable shared
   mount (master spec §47 topic 6).

## Pending (required by master spec section 47)

The remaining required records are written alongside the blocks that
implement each decision:

- Semantic timeline instead of DOM/video replay (§47 topic 1)
- Privacy-safe input capture defaults (§47 topic 4)
- SSE instead of WebSockets (§47 topic 5)
