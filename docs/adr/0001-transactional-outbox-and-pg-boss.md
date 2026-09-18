# ADR 0001 — Transactional outbox with pg-boss (PostgreSQL jobs, no Redis)

Status: accepted (Block 5)

## Problem

The ingest endpoint must return quickly and never lose an accepted event.
Heavy work (normalization, fingerprinting, grouping, aggregates, regression
notifications) belongs in the worker. Two failure modes must be impossible:

1. an event is accepted but never processed ("silently orphaned"), and
2. a redelivery (crash, retry, duplicate job) double-counts an occurrence.

pg-boss writes jobs through its own connection pool, so it cannot join the
ingest transaction directly. A naive "insert event, then send job" sequence
loses events when the process dies between the two writes.

## Options considered

1. **pg-boss `send()` inside the ingest transaction.** Not possible: pg-boss
   owns its pool and its SQL; there is no supported way to enlist it in an
   external Drizzle transaction.
2. **Redis-backed queue.** Adds a second stateful dependency, a second
   consistency domain and a new accepted-but-lost window (event committed in
   PostgreSQL, job lost in Redis). Rejected: PostgreSQL already offers
   `FOR UPDATE SKIP LOCKED`, transactions, unique constraints and `NOTIFY`.
3. **Poll the `events` table for `processing_state = 'pending'`.** Couples
   dispatching to the fact table, requires filtering/indexes that grow with
   retention, and has no natural "handed off" marker.
4. **Transactional outbox + pg-boss (chosen).** Ingest writes the event and an
   outbox row in one transaction. A dispatcher converts outbox rows into
   pg-boss jobs and marks them dispatched.

## Decision

- `event_processing_outbox(event_id PK, dispatched_at, attempt_count,
last_error, created_at)` is written in the same transaction as the event.
- A dispatcher claims bounded batches with
  `SELECT ... WHERE dispatched_at IS NULL ORDER BY created_at, event_id LIMIT n
FOR UPDATE SKIP LOCKED`, publishes one pg-boss job per row with a **stable
  job id = event id**, and only then sets `dispatched_at`.
- `dispatched_at` means "durably handed to pg-boss", never "processed". Final
  state lives in `events.processing_state`.
- A reconciliation loop retries rows that stayed pending beyond a stale
  threshold and reports the stale count.
- The processor is idempotent by database state: it locks the event row first
  and no-ops when the event is already processed.

## Crash window

```text
pg-boss send SUCCESS
        ↓
process crashes
        ↓
outbox dispatched_at still NULL
```

On restart the dispatcher publishes the same event id again. pg-boss inserts
with `ON CONFLICT DO NOTHING` on `(name, id)` and returns `null`; the
dispatcher treats that as success (the job already exists durably) and marks
the row dispatched. Even if a duplicate job were delivered, the processor's
event-row lock makes the second attempt a no-op: counters cannot increment
twice. Integration tests cover both halves of this window.

## Consequences

- Accepted events survive worker downtime: the outbox row is the durable
  handoff record, and the outbox can be inspected (attempts, last error).
- At-least-once job delivery with exactly-once issue accounting.
- One database, one consistency domain, no Redis: local self-hosting keeps
  only PostgreSQL + a filesystem.
- Cost: two extra loops (dispatcher, reconciliation) and one extra table —
  about 100 lines of bounded, testable code in exchange for the loss
  guarantee.
- Outbox rows are retained after dispatch instead of deleted, so
  `dispatched_at IS NULL` is always a complete list of unfinished handoffs.
