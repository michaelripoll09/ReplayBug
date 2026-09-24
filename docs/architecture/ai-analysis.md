# Optional Local AI Analysis

ReplayBug provides an optional, local-first issue analysis path: an operator can
point ReplayBug at a local Ollama endpoint, and the worker sends a bounded,
sanitized evidence bundle for one retained occurrence and stores the
model's structured hypothesis. The feature is an enhancement only — core
ReplayBug (ingest, grouping, issue detail, deterministic Playwright
reproduction, retention, deletion) works with no Ollama process, no model,
and no AI configuration at all.

There is no hosted or paid provider integration, no model download, no
tool/function calling, and no code execution. The provider endpoint is
trusted environment-only configuration; no API request can influence it.

## Component map

| Responsibility                              | Location                                                 |
| ------------------------------------------- | -------------------------------------------------------- |
| Capability parsing (worker)                 | `apps/worker/src/config.ts`                              |
| Capability parsing (API)                    | `apps/api/src/config.ts` (`resolveAiAnalysisCapability`) |
| Bounded evidence builder                    | `apps/worker/src/ai/evidence.ts`                         |
| Evidence loading from repositories          | `apps/worker/src/ai/evidence-loader.ts`                  |
| Prompt + JSON Schema output contract        | `apps/worker/src/ai/prompt.ts`                           |
| Provider seam                               | `apps/worker/src/ai/provider.ts`                         |
| Ollama `/api/chat` adapter                  | `apps/worker/src/ai/ollama.ts`                           |
| Domain contracts + output Zod schema        | `packages/contracts/src/ai-analysis.ts`                  |
| Job contract + queue options                | `apps/worker/src/queues/ai-analysis.ts`                  |
| Outbox dispatcher + reconciliation          | `apps/worker/src/dispatcher/ai-analysis-dispatcher.ts`   |
| Worker processor                            | `apps/worker/src/processors/process-ai-analysis.ts`      |
| HTTP routes                                 | `apps/api/src/routes/ai-analyses.ts`                     |
| Request/history/detail services + RBAC      | `apps/api/src/services/ai-analyses.ts`                   |
| Capability DTO endpoint                     | `apps/api/src/routes/meta.ts`                            |
| Tables + FKs + CHECKs + indexes             | migration `packages/db/drizzle/0008_ai_analyses.sql`     |
| Dashboard panel + disclaimer                | `apps/web/components/issues/ai-analysis-panel.tsx`       |
| Realtime types (`ai_analysis.ready/failed`) | `apps/api/src/realtime/broker.ts`                        |

## Configuration

Three environment variables, read only by process configuration modules
(`apps/worker/src/config.ts`, `apps/api/src/config.ts`). Neither process
fails startup because of them.

| Variable                      | Default | Meaning                                        |
| ----------------------------- | ------- | ---------------------------------------------- |
| `REPLAYBUG_OLLAMA_URL`        | —       | Ollama base URL, e.g. `http://localhost:11434` |
| `REPLAYBUG_OLLAMA_MODEL`      | —       | Local model name to request                    |
| `REPLAYBUG_OLLAMA_TIMEOUT_MS` | `30000` | Per-request timeout, `1000`–`120000`           |

`REPLAYBUG_OLLAMA_URL` must be an `http:`/`https:` URL with a host, no
username/password, no query string, no fragment, and no control characters.
A single trailing slash is normalised away before `/api/chat` is appended.
`REPLAYBUG_OLLAMA_MODEL` is trimmed and must be 1–256 characters with no
control characters; the model name is validated as a name only — ReplayBug
never pulls, downloads, or installs a model.

Capability is derived from the pair, not from probing the provider:

| State           | Condition                                                     | Effect                                |
| --------------- | ------------------------------------------------------------- | ------------------------------------- |
| `disabled`      | URL and model both unset                                      | No AI controls; requests answer `503` |
| `configured`    | Valid URL, valid model, timeout in range                      | Request/history/detail flows enabled  |
| `misconfigured` | Only one of URL/model set, invalid URL/model, invalid timeout | Requests answer `503`; no orphan rows |

Readiness is never affected. `GET /health/ready` reports PostgreSQL plus the
informational `checks.artifactStorage`; AI configuration and provider
availability are absent from readiness by design, and the API never probes
the provider endpoint.

## Request path and API surface

```text
POST /api/v1/events/:eventId/ai-analyses (Idempotency-Key required)
    | ai-analysis:request capability (member or above)
    | capability must be configured, else 503 AI_NOT_CONFIGURED (no rows)
    v
one transaction: ai_analyses (pending) + ai_analysis_outbox
                 + issue activity ai_analysis_requested (on insert only)
    v
ai_analysis_outbox --dispatcher--> pg-boss replaybug.generate-ai-analysis
    v
worker processor -> evidence bundle -> Ollama /api/chat -> strict validation
    v
one locked transaction: ready/failed + activity + requester notification
                        + pg_notify replaybug_project_updates
    v
dashboard panel (SSE invalidation, no polling loop)
```

| Endpoint                                   | Notes                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/events/:eventId/ai-analyses` | `202` new, `200` deduplicated; requires `Idempotency-Key` header (1–256 chars, else `400`)                  |
| `GET /api/v1/issues/:issueId/ai-analyses`  | Newest-first paginated history (`limit` 1–100, default 25, opaque `cursor`); summaries omit result text     |
| `GET /api/v1/ai-analyses/:id`              | One detail row: status, model, `analysisVersion`, result or error diagnostics                               |
| `GET /api/v1/meta/ai-analysis`             | Authenticated capability DTO: `configured`, `status`, `model` only — never the URL or any environment value |

Access uses the central capability policy: `ai-analysis:read` is granted from
`viewer` upward, `ai-analysis:request` from `member` upward. A viewer can read
history and detail but gets `403` on request (the UI also hides the control).
Cross-tenant or unknown occurrences and issues return `404 NOT_FOUND`, never a
distinguishing message. Idempotency is scoped to
`(requestedByUserId, eventId, analysisVersion, model, sha256(Idempotency-Key))`,
so a repeat key returns the existing row and a fresh key always appends a new
history row. Ready analyses are immutable; reanalysis is a new row.

## Evidence boundary

Evidence is built by `buildAiEvidence` from explicitly allowlisted records;
callers cannot pass database rows or payload bags. Only these fields are
included, each bounded after redaction:

| Field                                  | Source                             | Bound                                            |
| -------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `issue.message.text`                   | issue normalized message           | 2048 chars                                       |
| `issue.type` / `severity`              | issue                              | 128 chars each                                   |
| `issue.exceptionType`                  | first exception `type`             | 256 chars or `null`                              |
| `stack[].source` / `name`              | mapped frames (else raw frames)    | 512 chars each                                   |
| `stack[].line` / `column`              | frames                             | non-negative safe integers                       |
| `timeline[].kind`                      | event type of same-session events  | 128 chars                                        |
| `timeline[].message`                   | allowlisted per-type summary       | 1024 chars, non-empty only                       |
| `timeline[].occurredAt`                | event timestamp                    | 64 chars                                         |
| `network[].method` / `path`            | same-session failed network events | 16 / 1024 chars (path query + fragment stripped) |
| `network[].status`                     | HTTP status                        | integer `>= 400`                                 |
| `environment`                          | selected occurrence                | 128 chars                                        |
| `release.value`                        | selected occurrence release        | 256 chars or `null`                              |
| `timestamps.occurredAt` / `receivedAt` | selected occurrence                | 64 chars                                         |

Counts are capped at 10 stack frames, 30 timeline events (same session,
at or before the selected occurrence, newest first) and 10 network failures
of the same session. The serialized bundle is byte-capped at
`MAX_EVIDENCE_BYTES = 65536` (64 KiB): when over budget the builder trims
network entries first, then timeline entries, then stack frames, and raises
`EVIDENCE_BUNDLE_TOO_LARGE` only if nothing is left to trim.

Deterministic references make every claim addressable:

- `issue:message` and `release:current`
- `stack:<n>` — 1-based index into the emitted stack (mapped view preferred
  when the persisted symbolication actually mapped frames, otherwise raw)
- `timeline:<eventId>` and `network:<eventId>` — real occurrence ids the
  dashboard can link to

Text passes through one sanitizer before bounding: control characters are
replaced, whitespace collapsed, and `Bearer` tokens, `password`/`token`/
`cookie`/`authorization` assignment shapes, JWT shapes, email addresses, and
13–19 digit card-like runs become `[redacted]`.

What is never part of the bundle: raw telemetry payload bags, request or
response bodies, headers, cookies, credentials or API keys, source-map file
contents or `sourceMappingURL` values, artifact bytes, generated reproduction
code, comment bodies, and other users' data. The sanitized bundle is rebuilt
for each attempt and is never persisted or returned by any endpoint; only the
model's validated output is stored.

## Prompt and injection treatment

The prompt (`apps/worker/src/ai/prompt.ts`) has a fixed system instruction
that states telemetry evidence is untrusted data, that instructions inside
the evidence must never be followed, that only supplied evidence may be
used, that the model must not claim execution, repository access, network
access, or tools, and that only exact JSON matching the schema is accepted.
The bundle is inserted between `<<<UNTRUSTED_EVIDENCE_JSON>>>` and
`<<<END_UNTRUSTED_EVIDENCE_JSON>>>` delimiters as data. The request carries no
tools, no function declarations, no credentials, no model pull, and no
provider-supplied URL.

## Structured output contract

The provider request is `POST /api/chat` with `stream: false`, the canonical
JSON Schema in `format`, and `options.temperature: 0`. The generated text must
be read from `message.content` in an envelope whose `message.role` is
`assistant`. The only accepted result shape is the strict Zod schema in
`packages/contracts/src/ai-analysis.ts`:

| Key                 | Type                | Bounds                               |
| ------------------- | ------------------- | ------------------------------------ |
| `summary`           | string              | 1–4000 chars                         |
| `suspectedCause`    | string              | 1–4000 chars                         |
| `evidence`          | `{ ref, reason }[]` | 1–20 items; ref 1–128, reason 1–2000 |
| `reproductionSteps` | string[]            | 1–10 items; 1–1000 chars each        |
| `limitations`       | string[]            | 0–10 items; 1–1000 chars each        |

The schema is strict on both sides: `additionalProperties: false` in the JSON
Schema and `.strict()` in Zod, so unknown keys are rejected. Every `ref` is
also validated at runtime against the refs the builder actually emitted;
an unknown ref is rejected exactly like a schema violation. Response bodies
are stream-read with a 256 KiB cap, and `message.content` over 200,000
characters is rejected as an invalid envelope.

Malformed JSON, schema violations, and unknown refs are treated as one
retryable structured error: the adapter retries the structured request once
with a corrected-JSON instruction and then fails safely with
`MODEL_RESPONSE_INVALID` — never persisting or exposing the raw output.
Transport failures follow the retry taxonomy below instead. The persisted
`analysisVersion` is `AI_ANALYSIS_VERSION = "1.0.0"`, and it is part of the
idempotency scope.

## Outbox, job and retry taxonomy

Each request inserts one `ai_analysis_outbox` row keyed by the analysis id in
the same transaction as the pending row. The dispatcher claims a bounded
batch with `FOR UPDATE SKIP LOCKED` and reuses the existing event-outbox
settings (`REPLAYBUG_OUTBOX_BATCH_SIZE`, `REPLAYBUG_OUTBOX_POLL_MS`,
`REPLAYBUG_OUTBOX_RECONCILE_MS`), publishes outside the claim transaction with
the stable job id = analysis id (`ON CONFLICT DO NOTHING` → `null` means
already queued, still success), then marks `dispatched_at`. `dispatched_at`
means handed durably to pg-boss, not analyzed. Publish failures stay pending
with a bounded, single-line ≤500-char `last_error`, and a reconciliation loop
retries stale rows.

The job is `replaybug.generate-ai-analysis` with payload
`{ version: 1, analysisId }` — identifiers only, never evidence, prompt, or
output. Queue-level retries are bounded (`retryLimit` from
`REPLAYBUG_JOB_RETRY_LIMIT`, `retryDelay: 1`, backoff with
`retryDelayMax: 60`, `expireInSeconds: 120`).

| Provider condition                                                | Provider code                                                   | Retry?                                    | Terminal row code                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| Request aborted by timeout                                        | `MODEL_TIMEOUT`                                                 | Transient (retried while attempts remain) | `AI_ANALYSIS_TIMEOUT`                               |
| Connection/fetch failure                                          | `MODEL_CONNECTION_FAILED`                                       | Transient                                 | `AI_ANALYSIS_PROVIDER_UNAVAILABLE`                  |
| HTTP `408`, `429`, or `5xx`                                       | `MODEL_HTTP_TRANSIENT`                                          | Transient                                 | `AI_ANALYSIS_PROVIDER_UNAVAILABLE`                  |
| Other non-OK HTTP status                                          | `MODEL_HTTP_ERROR`                                              | No                                        | `AI_ANALYSIS_PROVIDER_REJECTED`                     |
| Invalid response envelope or oversized body                       | `MODEL_ENVELOPE_INVALID`                                        | No                                        | `AI_ANALYSIS_RESPONSE_INVALID`                      |
| Invalid JSON/schema/unknown ref after the retry                   | `MODEL_RESPONSE_INVALID`                                        | No                                        | `AI_ANALYSIS_RESPONSE_INVALID`                      |
| Capability disabled / misconfigured                               | `MODEL_DISABLED`, `MODEL_MISCONFIGURED`, `MODEL_CONFIG_INVALID` | No                                        | `AI_ANALYSIS_DISABLED`, `AI_ANALYSIS_MISCONFIGURED` |
| Missing/retention-removed occurrence, unreadable session evidence | — (evidence layer)                                              | No                                        | `AI_ANALYSIS_INVALID_EVIDENCE`                      |

Transient provider errors are rethrown while pg-boss retries remain and are
converted to the terminal failure only on the final attempt, so a row never
stays `pending` forever. Deterministic problems never throw — they mark the
row failed once.

Exactly-once observable effects are anchored on database state. The processor
preloads the row without a lock and no-ops for a missing or already
ready/failed row (so a retried or duplicated job makes no second model call),
then performs the terminal transition in one transaction that re-locks the
row, re-checks that it is still pending, and only then writes the transition
plus one activity row (`ai_analysis_completed` / `ai_analysis_failed`), one
requester-only notification, and one identifier-only `pg_notify`. If the
locked recheck fails, nothing is written. `requested_by_user_id` and
`event_id` are nullable, so a deleted user or expired event does not delete
history.

Logs carry identifiers, status, error code, and duration only — never
prompts, evidence, model output, or the provider URL.

## Degraded operation

- **Disabled or misconfigured:** the panel shows a local-configuration message
  and no request control; `POST` returns `503 AI_NOT_CONFIGURED` and creates no
  rows, so nothing is orphaned. History and detail reads still work.
- **Provider down (connection refused):** the job retries within its bounded
  budget and then fails the row with `AI_ANALYSIS_PROVIDER_UNAVAILABLE`. Ingest,
  grouping, issue detail, timelines, and deterministic Playwright reproduction
  keep working; this is verified end-to-end during an AI outage.
- **Provider slow:** the AbortController timeout aborts the request; the row
  ends `AI_ANALYSIS_TIMEOUT` after retries.
- **Invalid or malicious output:** strict validation rejects it; the row ends
  `AI_ANALYSIS_RESPONSE_INVALID` and no partial text is stored or displayed.
- **Event expired or deleted while pending:** the processor fails the row
  deterministically with `AI_ANALYSIS_INVALID_EVIDENCE` instead of retrying
  forever.
- **Realtime:** ready/failed transitions publish `ai_analysis.ready` /
  `ai_analysis.failed` on `pg_notify replaybug_project_updates` with only
  `version`, `type`, `projectId`, `issueId`, optional `eventId`, and
  `analysisId`; the broker drops anything unexpected, and the dashboard
  converges from SSE invalidation plus refetch-on-focus without polling.

## Hypothesis labeling

A ready analysis always renders the visible, plain-text disclaimer
`AI-generated hypothesis based on captured telemetry. It may be wrong.`
Suspected causes are labeled `Suspected cause`, and suggested steps are labeled
`Suggested steps` with the copy "Suggestions only — never executed, and
separate from the deterministic Playwright reproduction below." Suggested
steps are never executed by ReplayBug and are not a reproduction test.

Evidence refs are rendered as inert text: only the known `issue:message`,
`release:current`, `stack:<n>` and real-UUID `timeline:`/`network:` schemes
become navigable controls; anything else degrades to a plain "Evidence no
longer retained" note. All model-authored text is rendered as React text (no
`dangerouslySetInnerHTML`), so hostile HTML, Markdown, or URL-like strings stay
inert text. Failure states show a safe title/message chosen by error code;
raw `errorMessage`, provider bodies, and URLs are not rendered.

## Prohibitions

- No paid or hosted LLM API, and no OpenAI/Anthropic/Gemini integration. The
  only adapter is an Ollama-compatible `/api/chat` endpoint.
- No model download, pull, or auto-provisioning; a missing model is an
  operator-side configuration problem.
- No credentials: ReplayBug sends no API keys, cookies, or auth headers, and
  the provider URL is environment-only.
- No tools, function calling, shell, or code execution; model output is stored
  as inert text/JSON.
- No automatic fixes, patches, pull requests, GitHub integration, or remote
  execution of suggested steps.
- No source-map uploads, no arbitrary payload forwarding, and no public
  anonymous AI access.

## Retention and deletion

Analyses are not part of the raw-telemetry retention lifecycle:
`ai_analyses.event_id` is `ON DELETE SET NULL`, so when retention expires the
source event, the analysis history survives and reads back with
`eventId: null`; affected evidence refs then degrade to "Evidence no longer
retained". Note that pending analyses do not protect their event from
retention (unlike pending reproductions) — an analysis whose event expires
before it completes fails deterministically with
`AI_ANALYSIS_INVALID_EVIDENCE`.

`ai_analyses.issue_id` cascades from `issues`, so confirming a project or
workspace deletion removes its AI rows; `ai_analysis_outbox.analysis_id`
cascades from the analysis, so an outbox row never outlives its analysis.
`requested_by_user_id` is `ON DELETE SET NULL`, so deleting a user keeps the
history with a `System` requester label.

## Tests

Focused suites cover the pure evidence builder, prompt/injection boundary,
Ollama adapter protocol behavior (timeout, `408`/`429`/`5xx`, closed
connection, wrong schema, unknown refs), API request/history/detail/RBAC and
real-PostgreSQL idempotency, worker lifecycle and transient-vs-deterministic
retries, migration/retention/deletion regressions, and a full-stack E2E run
against an ephemeral protocol-compatible mock Ollama. A real Ollama smoke run
is optional and only reported when an installation and model already exist;
nothing is downloaded for it.

See also [Worker, Outbox and Operations](worker.md),
[Tenancy](tenancy.md#retention), and
[Self-hosting](../self-hosting.md) for the operator view.
