# Playwright Reproduction Generator (Block 8)

Block 8 generates a portable Playwright TypeScript test from one retained
occurrence. It is a pure two-stage pipeline — plan then render — with no
model inference, no remote browsing, and no server-side test execution.
The server writes code as text; the developer runs it locally.

Issue workflow, session timelines, SSE, releases and source maps are prior
blocks. Retention and invitation cleanup are now operational concerns; Ollama
analysis and public demo mode remain out of scope.

## Pipeline

```text
Issue detail (selected occurrence eventId)
    |
    | POST /api/v1/events/:eventId/reproductions (Idempotency-Key required)
    |   pre-validate evidence (buildGenerationInput)
    |   insert reproduction_tests (pending) + reproduction_generation_outbox
    v
reproduction_generation_outbox
    |
    | dispatcher (FOR UPDATE SKIP LOCKED, bounded batch)
    |   pg-boss send (job id = reproduction id → stable dedupe)
    |   mark dispatched_at
    v
pg-boss  replaybug.generate-reproduction  { version: 1, reproductionId }
    |
    | worker processor (pure CPU outside the completion transaction)
    v
buildWorkerGenerationInput → buildReproductionPlan → renderPlaywrightTest
    → validateGeneratedSyntax → mark ready/failed (one transaction)
    |
    | pg_notify replaybug_project_updates (reproduction.ready|reproduction.failed)
    v
Dashboard reproduction panel (copy / download / regenerate / history)
    |
    | developer runs the downloaded spec locally
    v
scripts/verify-generated-test.ts (loopback-only proof tool, never a service)
```

## Component map

| Responsibility                                                   | Location                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Pure generator (plan + render + validation helpers)              | `packages/reproducer/src/`                                                                                |
| Generator version constant                                       | `packages/reproducer/src/version.ts`                                                                      |
| Plan IR + action extraction                                      | `packages/reproducer/src/plan.ts`                                                                         |
| Playwright rendering                                             | `packages/reproducer/src/render.ts`                                                                       |
| Locator ranking                                                  | `packages/reproducer/src/locators.ts`                                                                     |
| Base-URL + route policy                                          | `packages/reproducer/src/base-url.ts`                                                                     |
| Escaping (literals + comments)                                   | `packages/reproducer/src/escaping.ts`                                                                     |
| Sensitive-value gate                                             | `packages/reproducer/src/sensitive.ts`                                                                    |
| Message normalization mirror                                     | `packages/reproducer/src/normalize.ts`                                                                    |
| Syntax validation (ts.transpileModule)                           | `packages/reproducer/src/syntax.ts`                                                                       |
| Public DTOs (summary has no code)                                | `packages/contracts/src/reproductions.ts`                                                                 |
| Request pre-validation + idempotency                             | `apps/api/src/services/reproductions.ts`                                                                  |
| HTTP routes (POST events, GET issue list, GET one, GET download) | `apps/api/src/routes/reproductions.ts`                                                                    |
| Job contract + queue options                                     | `apps/worker/src/queues/reproduction.ts`                                                                  |
| Worker evidence builder + processor                              | `apps/worker/src/processors/generate-reproduction.ts`                                                     |
| Outbox dispatcher + reconciliation                               | `apps/worker/src/dispatcher/reproduction-dispatcher.ts`                                                   |
| Dashboard panel                                                  | `apps/web/components/issues/reproduction-panel.tsx`                                                       |
| Tables + indexes + CHECKs + FK rules                             | `packages/db` (`reproduction_tests`, `reproduction_generation_outbox`, migration `0006_premium_nova.sql`) |
| Local proof runner                                               | `scripts/verify-generated-test.ts`                                                                        |
| Demo uncaught-error scenario                                     | `apps/demo/src/App.tsx` (`data-testid="demo-uncaught-error"`)                                             |
| E2E (unit-level assertions + full flow)                          | `apps/demo/e2e/reproduction-assertions.spec.ts`, `apps/web/e2e/reproduction.spec.ts`                      |

## Evidence inputs

Both the API pre-validation (`buildGenerationInput` in
`apps/api/src/services/reproductions.ts`) and the worker builder
(`buildWorkerGenerationInput` in
`apps/worker/src/processors/generate-reproduction.ts`) load the same
evidence; the two copies are parity-checked and the worker copy is
authoritative at generation time. The worker cannot import `apps/api`,
so the builder is duplicated deliberately with a keep-in-sync comment.

1. Anchor event by id; it must have a non-null `issue_id` whose issue
   belongs to the same project (otherwise NOT_FOUND / transient retry).
2. Environment resolution: exact name match on `event.environment`,
   falling back to the project's default environment. A missing or
   blank `base_url` is deterministic `REPRODUCTION_BASE_URL_REQUIRED`.
   `validateBaseUrl` additionally rejects non-http(s) schemes,
   embedded credentials, fragments, control characters and over-long
   values.
3. Timeline: keyset-paginated `listSessionEvents` over the anchor's
   telemetry session, keeping events with
   `sequenceNumber <= anchor.sequenceNumber`, then the last
   `TIMELINE_WINDOW = 50` rows. Each row becomes a
   `TimelineEvidenceItem` (`sequenceNumber`, `occurredAt`, `id`,
   `eventType`, optional `pageUrl`, sanitized `payload`).
4. Failure evidence from the anchor payload only:
   `exception` (first `values[]` type/value), `unhandled_rejection`
   (`reason`), `network` (`method` + `url` + integer `status_code` or
   null + optional `failure_type`), `console_error` (first `args[]`
   string). Anything else is `REPRODUCTION_UNSUPPORTED_FAILURE`.

Sanitization is allowlist-per-event-type (`sanitizeTimelinePayload`):
navigation keeps `to_url`/`from_url`; click keeps at most 5 locator
candidates (type must be one of `test_id | role_name | label | id |
name | css_fallback`, value 1–512 chars, finite confidence, no
control chars, no `password`/`secret`/`bearer `/`[REDACTED]`) plus
`element_tag`/`element_role`/`accessible_name`/`route`; input keeps
`input_type`/`input_name`/`input_id`/`has_value` and drops `value`
when `looksSensitiveValue` fires; network keeps
`method`/`url`/`status_code`/`failure_type`; console keeps up to 10
string args; message/custom_breadcrumb/sdk keep small string fields;
unknown types contribute `{}` (diagnostic-only downstream).

## Plan IR

`buildReproductionPlan` (`packages/reproducer/src/plan.ts`) maps
`GenerationInput` to a deterministic `ReproductionPlan`:

- Sorts by `(sequenceNumber, occurredAt, id)`; keeps the last
  `MAX_TIMELINE_ITEMS = 50` rows but pulls the earliest navigation in
  as `startRoute` context when the window sliced it away.
- Dedupes on a stable `breadcrumbKey`
  (`eventType;sequenceNumber;to_url/from_url/url/method/status_code;
locator values;input identity`), so standalone events plus embedded
  breadcrumb rings and retried duplicates emit once.
- Collapses consecutive fills on the same locator (input+change pair);
  the last value wins, and legitimately separated fills are preserved.
- Caps at `MAX_ACTIONS = 40` (over that is
  `REPRODUCTION_INVALID_EVIDENCE`); diagnostics and warnings each cap
  at 20 entries.
- `hasRedactedSteps` is derived from the final action list, so
  collapsing a fill pair cannot leave a stale flag.
- Carries `generatorVersion` (`1.0.0`), `issueId`, `issueTitle`,
  `occurrenceEventId`, `environment`, optional `release`, normalized
  `baseUrl` origin and the `assertion`.

Actions (`ReproductionAction`): `navigate { route }`,
`click { locatorExpression, strategy, brittle, label? }`,
`fill { locatorExpression, strategy, value?, redacted, inputName? }`,
`expectUrl { route }`.

## Action extraction

- `navigation`: first usable target establishes `startRoute`
  (returned, not emitted). A navigation immediately after a captured
  click becomes `expectUrl` (observed effect → URL assertion); any
  other later navigation becomes `navigate` (goto/waitForURL).
  Missing targets add a diagnostic; unsafe targets (see below) are
  omitted with a warning.
- `click`: `selectLocator` over the sanitized candidates; no usable
  locator → diagnostic + warning, no action emitted.
- `input`: locator derived from stable `input_id` (preferred) or
  `input_name`, else the candidate list. No stable locator →
  diagnostic + warning, and `hasRedactedSteps` is set when a value
  existed. Values passing `looksSensitiveValue` (or absent values)
  become `fill … redacted: true` with a placeholder.
- `network`/`console`/`custom_breadcrumb`/`sdk`/`message`/unknown:
  diagnostic comments only, never actions.

## Locator ranking

`selectLocator` (`packages/reproducer/src/locators.ts`) filters unsafe
candidates (empty, >512 chars, control chars, `password`/`secret`/
`bearer `/`[REDACTED]` values), then ranks by strategy
`test_id (0) > role_name (1) > label (2) > id (3) > name (4) >
css_fallback (5)` with confidence as the tiebreak. It never prefers a
lower-confidence CSS selector when a valid semantic candidate exists:
it returns the first non-brittle buildable expression, falling back to
a brittle one (caller emits a warning comment) only when nothing else
is usable.

Brittle signals: `:nth-child`/`:nth-of-type`, selector depth > 4
(`>` segments), UUID or 10+ digit numeric id parts, 20+ char random
token ids, generated CSS-module shapes (`css-xxxx`, `sc-xxxx`,
`_xxxxxx`), or values over 160 chars. `role_name` parses the SDK
`role[name="…"]` form; `name` emits a stable `[name="…"]` attribute
selector; `id` emits `#id`; unparseable or control-character values
are skipped.

## Navigation heuristic

`sanitizeRoute` (`packages/reproducer/src/base-url.ts`) reduces every
navigation target to a same-origin relative route or returns `null`
(omit + warn). It rejects `javascript:`/`data:`/`file:`/`ftp:`/
`vbscript:` schemes, backslashes, control characters and paths over
1024 chars; absolute http(s) URLs are reduced to `pathname + search`
with credentials rejected. Query handling drops the sensitive set
(`token`, `access_token`, `refresh_token`, `key`, `api_key`,
`password`, `secret`, `auth`, `code`, `client_secret`, `client_id`,
`authorization`, `bearer`, `jwt`, `session_id`, `sessionid`, `sid`,
`csrf`, `xsrf`, `_token`), keeps at most 20 params in sorted order,
bounds names/values (128/512), and falls back to the bare path when
the rebuilt query exceeds 2048 chars. When no navigation evidence
exists, the plan falls back to the occurrence `pageUrl` route, else
`/`, with a diagnostic.

`baseUrl` itself is origin-only (`protocol//host`): path/query on the
configured environment URL are ignored deliberately and `startRoute`
carries the path.

## Safe inputs and redacted placeholders

Input `value` is emitted only when present and
`looksSensitiveValue(value, inputName ?? inputId)` is false
(`packages/reproducer/src/sensitive.ts`): field hints (`password`,
`passwd`, `pwd`, `card`, `cvv`, `cvc`, `secret`, `token`, `bearer`,
`authorization`, `cookie`, `api_key`, `apikey`), `[REDACTED]`/
replacement-character markers, JWT shapes, `bearer <token>` shapes,
`secret/token/key = value` shapes, and 13–19 digit card-like runs all
force redaction. Redacted fills render as
`.fill('REPLACE_WITH_TEST_VALUE')` with an explanatory comment, set
`hasRedactedSteps`, and surface a dashboard warning banner telling
the reviewer to substitute a test value before running.

## Assertion strategies

`toAssertion` refuses to emit a false test: empty exception
type+message, empty rejection reason, empty console text, or network
evidence missing method/URL is `REPRODUCTION_UNSUPPORTED_FAILURE`.

- `pageerror` (exception, unhandled_rejection): the collector
  `page.on('pageerror', …)` gathers messages before any navigation;
  the assertion normalizes both sides with the embedded
  `normalizeObservedMessage` mirror and polls up to 10 s for either
  string to contain the other.
- `console_error`: same shape with
  `page.on('console', … type === 'error')`.
- `network`: `page.on('response', …)` matches on
  `request.method() === method && new URL(url).pathname === route`
  (query-insensitive; unassertable URLs are rejected up front and a
  null status without a `failureCategory` is rejected as
  non-deterministic). With a status code the test polls for that
  status; without one it polls for any matching response.

All assertions use bounded `expect.poll` (10 s) rather than sleeps:
delayed uncaught errors and async responses still pass, and a missing
failure still fails.

## Generator versioning

`REPRODUCTION_GENERATOR_VERSION = "1.0.0"`
(`packages/reproducer/src/version.ts`) is the single canonical
version. It is persisted per row (`reproduction_tests.
generator_version`), embedded in the generated file header comment,
shown in the dashboard (`framework · language · version`), and part
of the idempotency scope: the same user+event+key against a different
generator version creates a new row instead of deduping. Material
changes to generation semantics require bumping this constant.

## Async queue and outbox

Request path: `POST /api/v1/events/:eventId/reproductions` requires
an `Idempotency-Key` header and `reproduction:generate` capability;
the service pre-validates evidence via `buildGenerationInput` (so a
known-bad request fails fast instead of leaving an orphan `pending`
row), then inserts the pending `reproduction_tests` row plus its
`reproduction_generation_outbox` row in one transaction.

Dispatch: `dispatchReproductionOutboxBatch` claims with
`FOR UPDATE SKIP LOCKED`, publishes each row to pg-boss outside the
claim transaction with the stable job id = reproduction id
(`ON CONFLICT DO NOTHING` → `null` means deduplicated, still
success), then marks `dispatched_at`. Failures stay pending with a
single-line ≤500-char `last_error`. A reconciliation loop retries
stale rows. Queue: `replaybug.generate-reproduction`,
`{ version: 1, reproductionId }`, bounded retries with backoff
(`retryLimit` from worker config, `retryDelayMax: 60`,
`expireInSeconds: 120`).

Processor: preloads the row without a lock (missing or already
terminal rows no-op), builds plan/render/validates syntax outside any
transaction (no `SELECT FOR UPDATE` held during pure CPU work),
then in one transaction locks the row, re-checks terminal state, and
marks ready (`code`, `hasRedactedSteps`, activity row,
`reproduction.ready` notify) or failed (`errorCode`, bounded
`errorMessage`, activity row, `reproduction.failed` notify plus an
in-app `reproduction_failed` notification to the requester).
Deterministic problems (`ReproductionError`, syntax invalid) mark
failed and return; only unexpected errors throw for pg-boss retry.
Retention protects events referenced by pending reproductions. Once a
reproduction is terminal, later raw-evidence expiry can set `event_id = NULL`;
the reproduction history remains, while a worker that encounters missing
required evidence treats it as deterministic `REPRODUCTION_INVALID_EVIDENCE`.
Logs carry ids/duration/status only — never code, payloads or secrets.

Storage: `reproduction_tests` (`status pending|ready|failed`,
`language typescript`, `framework playwright`, nullable `code`,
`error_code` allowlist, `idempotency_key_hash`; `issue_id` cascades,
`event_id`/`generated_by_user_id` SET NULL so expiry or user deletion
never deletes history) and `reproduction_generation_outbox`
(`reproduction_id` PK cascading, `dispatched_at` = handed to pg-boss,
not generated). See migration `0006_premium_nova.sql`.

## Idempotency

Two layers: HTTP dedupe on `sha256(Idempotency-Key)` scoped to
`(generatedByUserId, eventId, generatorVersion)` — a repeat with the
same key returns the existing row (`200`, `deduplicated: true`)
instead of inserting; a fresh key always creates a new history row
(`202`) so Regenerate appends history. Queue dedupe on the stable
pg-boss job id (reproduction id) plus processor idempotency on DB
row state (terminal rows no-op, `SELECT FOR UPDATE` + re-check
inside the completion transaction).

## Security: escaping and what the server never does

- All telemetry-derived strings flow through
  `packages/reproducer/src/escaping.ts`: code literals use
  `tsSingleQuoteLiteral` (control-char strip, backslash/quote/
  newline escaping — output is an inert single-quoted literal, no
  backticks or `${}` breakout) and comments use
  `safeCommentFragment` (whitespace collapse, `*/`/`<!--`/`-->`
  neutralization, bounded length). Download filenames are rebuilt
  from alphanumerics only (`replaybug-<8>-<8>.spec.ts`).
- Base URLs, routes and network paths are validated as above; no
  credentials, fragments, or non-http(s) targets survive.
- The server never browses to the base URL (it is emitted into code
  text only), never launches Playwright, never executes generated
  code, and never stores secrets: job payloads carry only the
  reproduction id, LIST responses omit `code`, and error messages are
  single-line bounded strings.

## CI local verifier

`scripts/verify-generated-test.ts` (`pnpm verify:generated-test`)
is a manual/CI proof tool, not a service: given a `--code-file` it
(1) gates `--target` (default `$REPLAYBUG_DEMO_URL` or
`http://localhost:5173`) to loopback hosts only (`localhost`,
`127.0.0.1`, `::1` over http(s), no credentials), (2) validates
TypeScript syntax via `transpileModule`, (3) rejects `node:`/`fs`/
`child_process` imports and any embedded non-loopback http(s) URL,
(4) copies the spec to a fresh temp dir and runs
`playwright test <file> --reporter=line` against the local demo.
Exit 0 requires syntax-valid AND a passing run. CI generates a real
demo reproduction, syntax-checks it, executes it against the local
demo only, and runs a negative control — no remote target is ever
allowed.

## E2E proof

- `apps/demo/e2e/reproduction-assertions.spec.ts`: drives the demo
  privacy form and the `demo-uncaught-error` pageerror scenario
  through ingest, asserts semantic locator selection
  (`getByTestId('demo-uncaught-error')`), safe-value emission vs
  password/token redaction, and pageerror assertion shape.
- `apps/web/e2e/reproduction.spec.ts` (E2E-REPRO): full stack
  register → project → environment base URL → demo origin → drive
  Chromium → issue → Generate → poll to ready → assert semantic
  locator + pageerror assertions → copy → download-equals-stored →
  syntax-validate → execute against the local demo (PASS) and a
  negative control without the failure (FAIL) → regenerate yields two
  history rows → viewer can inspect but not generate.
