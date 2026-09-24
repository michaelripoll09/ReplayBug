# Fingerprinting and Issue Grouping

Issue grouping must be deterministic and explainable: the same defect groups
into the same issue, and a different defect never silently joins it. This
document describes the exact rules implemented in
`packages/db/src/domain/` (pure functions, no I/O).

## Grouping key

```text
signature   = canonical normalized components, serialized as a JSON array
fingerprint = SHA-256(projectId + ":" + signature), hex lowercase, 64 chars
```

- The signature is a JSON **array** of strings in fixed order, so
  serialization never depends on object key order.
- The project namespace is part of the hash: two projects never share a
  fingerprint even with identical signatures.
- SHA-256 without a secret is enough: the fingerprint is a grouping key, not
  a credential, and it must stay reproducible across self-hosted deployments.
- `issues.fingerprint_signature` stores the canonical signature next to the
  hash so suspicious collisions can be diagnosed. The hash remains the only
  grouping key.
- `release` is **never** part of the signature: the same
  defect is tracked across deployments. Session id, user hash, timestamp,
  event id and environment are excluded as well.

## Message normalization

Applied before hashing, in this order (message-level):

| Pattern                                        | Placeholder     | Notes                                                     |
| ---------------------------------------------- | --------------- | --------------------------------------------------------- |
| URL / route tokens                             | normalized path | origin, query string and fragment dropped                 |
| UUIDs                                          | `:id`           |                                                           |
| ISO-8601 timestamps                            | `:timestamp`    | with/without milliseconds and timezone                    |
| memory-address-like values (`0x…`, ≥6 hex)     | `:addr`         |                                                           |
| long integers (≥5 digits)                      | `:id`           | status codes (500), ports (8080) and years stay intact    |
| long hex ids (≥8 hex chars, ≥1 digit)          | `:hex`          | hexadecimal-letter-only words like `deadbeef` stay intact |
| long opaque tokens (≥20 chars, letters+digits) | `:token`        | JWT segments, cache-busters                               |

Conservative by design. Examples:

```text
Cannot load user 7192381 at /users/7192381   →  Cannot load user :id at /users/:id
GET /api/users/8831921?page=2                →  GET /api/users/:id
Version 1.2.3 crashed on port 8080           →  unchanged
```

Path segments follow the same rules, plus content-hash normalization inside
file names: `index-Bx3K9mPQ.js` → `index-:hash.js`, so bundled file names do
not split issues across builds.

## Exception and unhandled-rejection signatures

```text
exception:
  ["exception", <normalized class>, <normalized message>, <frame>, <frame>, ...]

unhandled_rejection:
  ["unhandled_rejection", <normalized reason>]
```

- Class: `values[0].type`, trimmed (`Error` when empty).
- Message: `values[0].value` after message normalization.
- Frames: up to 5 canonical frames, preferring `in_app === true`; when no
  frame is marked in-application the first usable frames are used, so an
  error is never left ungrouped just because `in_app` is missing.
- Frame form: `function@file:line`. Column numbers are intentionally excluded:
  they are unstable across builds and would split identical defects.
- File names drop the origin (environments differ, the defect does not),
  remove query strings and normalize ids and build hashes.
- With no stack frames at all, the class and message alone still produce a
  stable fingerprint.

## Network failure signatures

```text
["network", <METHOD>, <normalized path>, <status or failure category>]
```

- Path: origin, query string and fragment removed; unstable segments
  normalized (`/api/users/7192381` → `/api/users/:id`).
- Status: exact code when present (`500`, `404`), otherwise the failure
  category (`timeout`, `network_error`, ...). A different method or status is
  a different issue.
- Duration, timestamps and release are excluded.
- A network event that neither failed (status ≥ 400 / status 0 / null) nor
  carries a failure category is processed as a non-issue.

## Console-error signatures

```text
["console_error", <normalized joined args>]
```

All captured args are joined and normalized, so unstable values inside
console output (ids, timestamps) do not split issues. The telemetry contract
currently carries no console source location, so no location component
participates in the signature. If one is added later it becomes a deliberate,
documented grouping change (existing issues keep their fingerprint; new
events start new ones), never a silent inclusion.

## Message-event signatures

```text
["message", <level>, <normalized message>]
```

Only `warning`, `error` and `critical` create issues. `warning` issues carry
severity `warning`; `error`/`critical` carry `error`. `info` and `debug` are
processed as non-issues.

## Titles and severity

| Type                  | Title example                                                 | Severity      |
| --------------------- | ------------------------------------------------------------- | ------------- |
| `exception`           | `TypeError: Cannot read properties of null (reading 'total')` | error         |
| `unhandled_rejection` | `Unhandled rejection: Failed to load profile :id`             | error         |
| `console_error`       | `Console error: Payment initialization failed`                | error         |
| `network`             | `GET /api/users/:id → 500`                                    | error         |
| `message`             | `Warning: Payment initialization failed`                      | warning/error |

Titles are normalized (never re-introducing unstable values), bounded to 200
characters and stored with the normalized message and severity.

## Non-issue events

`navigation`, `click`, `input`, `custom_breadcrumb` and `sdk` events are
acknowledged (`pending → processed`) without fingerprint or issue, so the
outbox never strands them.

## Developer override (custom fingerprint)

`captureException(error, context?, fingerprint?)` accepts an optional custom
fingerprint array (contract: max 5 items, 256 chars each). Rules:

- Custom components are **sanitized** (secret redaction) and light-normalized
  (whitespace collapsed, trimmed, bounded) before leaving the browser and
  again before hashing server-side.
- When at least one usable item remains, the signature becomes
  `["custom", ...items]` and replaces the automatic components entirely:
  different messages group together while the custom array matches.
- The project namespace still participates in the hash, so the same custom
  array in two projects yields different fingerprints.
- An unusable array (empty or blank items) falls back to automatic grouping
  instead of rejecting the event.
- The override is available only on manual capture (`captureException`);
  automatic error capture never fabricates one.

## Collision diagnostics

`issues.fingerprint_signature` keeps the canonical signature. When two
visually different defects are suspected of colliding, compare
`fingerprint_signature` values: identical signatures hash identically by
construction, and differing signatures cannot share a hash unless SHA-256
itself collides. To investigate a suspected over-merge, inspect the signature
(which placeholders were applied) rather than the hash.

## Raw-stack fallback limitations

- When source maps are unavailable, frames are the **raw sanitized stack** sent
  by the browser. Minified releases then group by minified file/line
  (`/assets/index-:hash.js:1`), which still separates defects by message/class
  but cannot distinguish two different minified call sites with the same
  message.
- The signature builder takes frames as input without knowing their source, so
  the source-map pipeline can supply symbolicated frames without changing the
  grouping rules.
- Console locations and chained-exception analysis are not implemented; only
  `values[0]` participates.
