# Performance evidence

ReplayBug does not publish invented throughput, latency, or scale numbers. Record a
measurement with its command, environment, input shape, revision, and complete
output. The local benchmark is a reproducible development tool, not an SLA, load
test, or CI gate.

## Self-contained local benchmark

Run:

```bash
pnpm benchmark:ingest
```

The command creates a uniquely named `replaybug_benchmark_*` PostgreSQL database
on the local server, applies real migrations, starts real API and worker child
processes on dedicated loopback resources, and removes the database, temporary
artifacts, child processes, and ports on success, failure, or interruption.

No ingest DSN or key is supplied by the user. The benchmark creates a synthetic
user, workspace, project, allowed origin, and public ingest key through the local
API; the key remains in process memory and is never printed. It rejects non-loopback
PostgreSQL hosts. By default it uses the local test PostgreSQL URL; set
`REPLAYBUG_DATABASE_URL` only to choose another **loopback** PostgreSQL server.

The bounded primary ingest defaults are 10,000 events, batches of 50, and concurrency 10. They can be changed within safe caps:

```bash
pnpm benchmark:ingest --events 10000 --batch-size 50 --concurrency 10
```

The benchmark performs all of the following against the isolated database:

- HTTP `POST /api/ingest/v1/batch` warmup and primary ingest through the real API.
- Repeated accepted-to-worker-processed-to-issue-available latency samples through
  the real HTTP API, PostgreSQL outbox, pg-boss, and worker.
- A retained direct-SQL fixture of exactly 100,000 synthetic events across realistic
  issues, statuses, environments, releases, sessions, timestamps, text, and tags.
- Repeated authenticated issue-list API measurements after deliberate warmup for
  default ordering, status, environment, release, free-text, combined filters, and
  occurrence-count sort.
- Safe summaries of `EXPLAIN ANALYZE` for representative underlying queries.

It reports the date/time, revision, Node, platform, CPU, logical CPUs, memory,
PostgreSQL version, ingest counts and percentiles, worker latency percentiles,
issue-list median/p95/max, and measured query-plan summaries. It deliberately adds
no index or production optimization: investigate a measured pathology first.

## Measured local runs

These engineering benchmarks exercised the real HTTP API, PostgreSQL, outbox,
pg-boss, worker, authenticated issue-list API, direct-SQL fixture, and `EXPLAIN`.
They are not an SLA or a production capacity claim, and the results do not
generalize to other hardware, PostgreSQL configurations, workloads, or deployments.
Remote GitHub Actions were not run because this work was not pushed. Secrets were
not printed, and benchmark databases and temporary resources were removed during
cleanup.

### Primary run

- **Command:** `pnpm benchmark:ingest --events 10000 --batch-size 50 --concurrency 10`
- **Date/time:** 2026-09-21T16:40:15.465Z; **revision:** `3e15bb5642ed8647bec6bfe10dc3d57f3ed7da63`
- **Host:** Node v24.21.0; win32 10.0.26200 (x64); AMD Ryzen AI 7 350 w/ Radeon
  860M; 16 logical CPUs; 31.1 GiB memory; PostgreSQL 17.11.
- **Isolation:** `replaybug_benchmark_32780_d7f2b4107017976a` was removed during
  cleanup and is not persistent.
- **Ingest:** 10,000 requested and accepted; batch size 50; concurrency 10; 200
  requests; 0 failures; 12,424.37 ms total; 804.87 events/s; 16.10 requests/s;
  latency p50/p95/p99: 588.08/760.56/846.83 ms.
- **Processing target:** 15 samples; p50/p95/p99/max:
  496.56/529.63/529.63/529.63 ms. Typical processing met the approximately
  5-second engineering target.
- **Dataset shape:** exactly 100,000 retained direct-SQL events across 1,000
  issues and 500 sessions. Issues span `open`, `investigating`, `resolved`, and
  `ignored`; environments `production`, `staging`, and `development`; releases
  `web@3.0.0`, `web@3.1.0`, and `web@3.2.0`; titles, messages, and tags are
  synthetic, and events are distributed across issues and sessions with timestamps.
- **Issue-list API:** five warmups and 20 measured requests per query, with setup
  excluded. Median/p95/max (ms): default 6.30/9.03/9.11; status 5.50/6.12/6.58;
  environment 7.22/13.22/14.53; release 6.05/6.63/6.81; text search
  10.08/13.15/25.02; combined 6.39/7.64/8.26; `occurrence_count` descending
  5.58/6.53/7.37.
- **EXPLAIN:** root `Limit` time: default 0.30 ms; environment `EXISTS` 1.53 ms;
  free-text 1.23 ms. These bounded plans reported no sequential/pathological scan,
  sort spill, or nested-loop issue.

### Smaller reproducibility run

- **Command:** `pnpm benchmark:ingest --events 500 --batch-size 25 --concurrency 4`
- **Date/time:** 2026-09-21T16:45:03.683Z; **revision:**
  `3e15bb5642ed8647bec6bfe10dc3d57f3ed7da63`.
- **Host:** same Node v24.21.0, win32 10.0.26200 (x64), AMD Ryzen AI 7 350 w/
  Radeon 860M, 16 logical CPUs, 31.1 GiB memory, and PostgreSQL 17.11 environment
  as the primary run.
- **Ingest:** 500 accepted; batch size 25; concurrency 4; 20 requests; 0 failures;
  987.77 ms total; 506.19 events/s; 20.25 requests/s; latency p50/p95/p99:
  193.20/210.66/215.77 ms.
- **Processing target:** 15 samples; p50/p95/p99/max:
  493.19/518.15/518.15/518.15 ms.
- **Dataset and queries:** the same exact 100,000-event fixture and issue-list
  query shapes as the primary run. Median/p95/max (ms): default 5.92/10.62/12.92;
  status 5.09/6.16/6.61; environment 5.88/7.35/7.64; release 5.19/6.24/6.46;
  text search 9.87/14.81/16.15; combined 6.19/7.10/9.11; `occurrence_count`
  descending 4.99/5.61/6.05.
- **EXPLAIN:** root times: default 0.34 ms; environment 2.26 ms; free-text
  1.57 ms. Cleanup completed.

Neither run justifies an optimization or migration conclusion; investigate a
reproducible measured pathology before changing production design.

## Measurement record template

Capture the complete command output with this context; replace placeholders only
with an actual local run.

```text
Command: pnpm benchmark:ingest --events <actual-events> --batch-size <actual-batch-size> --concurrency <actual-concurrency>
Revision: <commit from report>
Date/time: <timestamp from report>
Host / Node / PostgreSQL: <values from report>

<complete ReplayBug local benchmark report output>
```

Do not treat one developer-machine run as a production capacity claim. Compare runs
only when the revision, PostgreSQL configuration, hardware, and input shape are
recorded together.
