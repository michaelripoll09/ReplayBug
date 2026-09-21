# Dashboard — Issues API, Metrics, Realtime (Block 6)

> Complete through T18. Covers the Block 6 dashboard: query shapes,
> metrics, timelines, DTO boundaries, search, realtime fan-out, cache
> invalidation, degradation, authz and output security.

## Search strategy (T05)

Issue search uses PostgreSQL only. No Elasticsearch, Meilisearch or other
service is introduced.

- **Indexed content**: `issues.title`, `issues.normalized_message`
  (GIN trigram indexes `issues_title_trgm_idx` /
  `issues_normalized_message_trgm_idx`, migration `0003`), plus tag
  names/slugs through the `issue_tag_assignments` join where practical.
- **Query shape** (`IssueListRepo.listIssues`, `q` filter): one OR clause —
  `similarity(title, q) > 0.15 OR similarity(normalized_message, q) > 0.15`
  `OR title ILIKE %q% OR normalized_message ILIKE %q%`
  `OR EXISTS (tag name/slug ILIKE %q% OR similarity(tag name, q) > 0.15)`.
- **Why both**: the `%` operator is case-sensitive, so `ILIKE` covers exact
  case-insensitive substrings; the explicit `0.15` similarity threshold
  covers transposed-letter typos without depending on the server's
  `pg_trgm.similarity_threshold` setting (deterministic across environments).
- **Scoping**: every search runs inside `project_id = $1`, so cross-project
  leakage is impossible by construction; tag matching joins through the
  issue's own assignments only.
- **LIKE safety**: `%`, `_`, `\` in user input are escaped (`ESCAPE '\'`).
- **Pagination**: keyset cursor over the active sort with a stable `id`
  tiebreak — no duplicates/skips when many issues share a sort value.
- **Verified**: typo (`Chekout paymnt failure`), case (`CHECKOUT`), tag-name
  (`frontend`), empty-result and cross-project isolation integration tests
  on real PostgreSQL (`issues-list.integration.test.ts`).

## Query and index notes (T16)

Observed 2026-09-18 on dev PostgreSQL with a 200-issue single-project
fixture (`EXPLAIN (ANALYZE, BUFFERS)`, representative list shapes):

- **Default list** (`project + ORDER last_seen DESC, id LIMIT 26`):
  `Index Scan Backward` on `issues_project_last_seen_idx`, execution
  ~0.12ms, 11 shared buffers. No separate sort node at this scale
  (incremental sort only resolves the `id` tiebreak).
- **Status filter**: same index with a `status` filter (~0.07ms here —
  fixture is all-open). The composite
  `issues_project_status_last_seen_idx` exists for selective statuses.
- **Trigram search** (`similarity(title) > 0.15 OR title ILIKE`): the
  planner prefers the ordered index scan + filter at small scale (~0.17ms)
  and ignores the GIN indexes — correct, since LIMIT stops after 26 rows.
  The GIN indexes (`issues_title_trgm_idx`,
  `issues_normalized_message_trgm_idx`) pay off on larger corpora; the
  explicit `0.15` threshold keeps behavior independent of the server's
  `pg_trgm.similarity_threshold`.
- **Environment filter** (`EXISTS` on events): nested loop over the
  ordered issue scan with a per-issue existence probe (~0.46ms empty).
  Fine at dashboard page sizes; revisit against the 100k-retained-events
  target (§42) with a benchmark before adding denormalized env columns.
- **Keyset pagination** keeps every page a bounded index range scan —
  no OFFSET drift, no duplicates/skips under concurrent inserts (tie
  stability covered by `paginates sort ties stably` in
  `issues-list.integration.test.ts`).
- **Tags**: `EXISTS` through `issue_tag_assignments_tag_idx` +
  project-local `issue_tags_project_slug_unique`; batch tag hydration
  (`listTagsForIssues`) keeps the list at constant query count.

## Metrics (T06)

`GET /api/v1/projects/:projectId/metrics?range=24h|7d|30d`
(`MetricsRepo.getProjectMetrics`, all-SQL aggregates — `COUNT`,
`COUNT(DISTINCT)`, `date_trunc` buckets, `GROUP BY`; raw event sets never
load):

- **Counts**: unresolved (`open`+`investigating`), new issues in range,
  linked occurrences in range, distinct affected sessions, regressions
  (`regression_detected` activity in range).
- **Top 5** issues by in-range occurrences; **distributions** by
  environment and release (`NULL` release → `"unknown"`).
- **Buckets**: UTC-aligned, fixed counts — 24 hourly for `24h`, 7/30 daily
  otherwise (≤48h hourly else daily). The trailing partial
  bucket folds into the last fixed bucket so bucket sums always reconcile
  with the scalar totals.
- **Gotcha**: `node-pg` returns `date_trunc` `timestamp` as string, not
  `Date` — the repo normalizes both shapes (`bucketTime`).

## Timelines (T07/T10)

- **Occurrences** (`GET .../issues/:id/occurrences`): envelope metadata
  only (ids, timestamps, env/release/page/type/state), newest-first,
  keyset over `(occurred_at, id)`.
- **Event detail** (`GET /api/v1/events/:id`): explicit per-type DTOs
  (10-type Zod discriminated union). The mapper picks known-safe keys from
  the stored sanitized payload and drops mechanism internals, fingerprint
  overrides, breadcrumb/SDK data bags and input values; stack frames cap
  at 50; unknown stored types degrade to the SDK shape.
- **Session events** (`GET .../sessions/:id/events`): `(sequence, id)`
  ASC, keyset, bounded (default 100, max 200), each with a server-derived
  plain-text `summary`.
- **Timeline context** (`GET .../events/:id/timeline-context`): default 20
  before / 5 after by sequence, bounded (100/50). Powers both the embedded
  issue-detail window and full session splicing without loading sessions.

## DTO boundaries (T03)

Contracts (`@replaybug/contracts`) are the public promise; service mappers
(`apps/api/src/services/dto.ts`) build them field-by-field — never by
spreading Drizzle rows. Never exposed: `fingerprint` material,
`payload_json`, `sdk_session_id`/`anonymous_user_hash`, key hashes,
pg-boss internals, `mechanism.data`, comment bodies inside activity
metadata. Fastify serializes responses with `fast-json-stringify`, which
**drops undeclared keys from bare `type: object` schemas** — activity
`metadata` therefore declares `additionalProperties: true` (learned the
hard way in T09).

## Authz (T02/T04–T12)

Central `policy.ts` capabilities, enforced server-side on every route via
`requireWorkspaceCapability` (+ `requireProjectAccess` anti-enumeration,
cross-tenant reads as NOT_FOUND):

- `issue:read` (viewer+), `issue:update-status`/`assign`/`manage-tags`/
  `comment` (member+), `session:read` (viewer+),
  `notification:read-own` (viewer+, always scoped to the caller).
- Assignment additionally requires the assignee to be a workspace member
  (non-members → 403, never existence-revealing 404); comment edit is
  author-only; tag ids are project-local (foreign → 404); notification
  writes scope ownership in the SQL `WHERE` clause.
- The web `lib/rbac.ts` mirrors affordances for hiding controls only —
  the API is the authority.

## Cache invalidation (T13)

`apps/web/lib/queries.ts` key factories (param-stable tuples) +
`useProjectRealtime` hook mapping stream types to **exact key prefixes**
(list/detail/metrics/comments/activity/tags) — never a global
`invalidateQueries()`. Mutations invalidate the same targeted keys.

## Degraded operation (T12/T16)

- **Worker down**: ingest still stores + outboxes (prior blocks); the
  dashboard reads aggregates that simply stop advancing.
- **SSE down**: the stream opens `degraded` (ready gated on LISTEN via
  `broker.whenReady()`); every view works through normal REST refetch.
  `pg_notify` with no listeners is a no-op, so mutations commit normally.
- **Missing data**: expired occurrences → honest "aggregates remain"
  notes; missing source maps → raw stacks (see below); empty states
  distinguish "no issues" from "no matches".

## Output security (T15)

- Zero `dangerouslySetInnerHTML` in app code (audited); telemetry renders
  as React text (auto-escaped).
- Comments render through `SafeMarkdown` (`react-markdown` + `remark-gfm`
  - `rehype-sanitize`, deliberately no `rehype-raw`): scripts, handlers
    and `javascript:` URLs are stripped; links get
    `rel="noopener noreferrer nofollow"`.
- Raw stacks render as monospace **text** labeled "unsymbolicated" —
  symbolication is a later block and nothing implies otherwise.
- Static headers (`nosniff`, strict referrer, `DENY` framing) ship in
  `next.config.ts`. No static script-src CSP: it would break Next.js
  hydration or need `unsafe-inline`; script XSS defense rests on the two
  points above, covered by component tests (`markdown.test.tsx`,
  `security.test.tsx`) and Playwright probes (`issues-dashboard.spec.ts`
  E2E-B6-4).
