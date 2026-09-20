# Source Maps — Releases, Artifacts, Symbolication (Block 7)

Block 7 turns minified production stacks into original-source stacks:
secret-token CLI uploads build artifacts per release, the worker
symbolicates event frames against those artifacts **before**
fingerprinting, and the dashboard shows mapped stacks with a raw fallback.
Telemetry, grouping, and realtime keep working when maps are missing or
storage is down — degradation is specified, not accidental (master spec
§54).

Explicitly out of scope: fetching maps from anywhere except the upload
pipeline (no external artifact download, no server-side source fetching),
code snippets, auto-fixes, S3/object storage, and external artifact services.
Telemetry retention and local artifact deletion now exist, but they are separate
operations described below and in [Self-hosting](../self-hosting.md).

## Release identity

Releases live in `releases` (`packages/db`, migration `0004`):

- Unique per `(project_id, version)`. `version` is 1–128 chars, never
  trimmed, exact-match — **not** semver-restricted (`web@1.4.2`,
  `demo@1.0.0`, `1.4.2` are all valid).
- Optional `commit_sha` (7–64 hex chars) and `repository_url`
  (`http(s)` shape, ≤2048 chars). Both are recorded metadata: the URL is
  never fetched, so there is no SSRF surface.
- Identity metadata is **immutable**: creating the same version with
  identical metadata is idempotent (`200 created: false`); differing
  metadata is `409 RELEASE_VERSION_CONFLICT` with the stored row
  untouched. Events reference releases by version string (telemetry may
  predate registration — no FK from events), so the conflict rule keeps
  history unambiguous.

## Artifact upload

Artifacts live in `release_artifacts` (unique per
`(release_id, artifact_path)`, type `source_map | minified_asset`,
`content_hash`, `size_bytes`) with bytes in local storage (see
[Self-hosting](../self-hosting.md)).

Pipeline (`POST /api/v1/cli/releases/:version/artifacts/check` then
multipart `POST .../artifacts`, `apps/api/src/services/artifacts.ts`):

1. **Preflight** a bounded manifest (~500 entries, ~250 MiB aggregate):
   per-artifact verdicts `upload` / `exists` (same path+hash stored) /
   `conflict` (same path, different bytes). Client hashes are advisory
   only — the server revalidates everything at upload.
2. **Multipart upload** (exactly one file part plus `artifactPath` /
   `artifactType` fields): the server streams to a temp file while
   computing SHA-256 + size, validates content, then compares against
   the stored row. Same hash → idempotent `200 created: false`;
   different hash → `409 ARTIFACT_PATH_CONFLICT`, no overwrite.
3. **Validation**: `.map` bytes must parse as Source Map v3 JSON
   (`version === 3`, `sources` array, `mappings` string;
   `validateSourceMapBytes` in `@replaybug/artifacts`) — failures are
   `400 INVALID_SOURCE_MAP` with no row and no stored file. Index maps
   (`sections` without `mappings`) are rejected: the worker only
   consumes basic maps. Assets face extension/MIME allowlists
   (`.map`/`.js`/`.mjs`/`.cjs`) plus executable/markup content sniffing.
4. **Caps**: per-file 25 MiB default (`REPLAYBUG_ARTIFACT_MAX_FILE_BYTES`),
   enforced by multipart limits _before_ unbounded buffering
   (`413 ARTIFACT_TOO_LARGE` past it).
5. **Compensation**: the staged temp dir is removed on success,
   validation failure, abort, storage failure, and unexpected errors; a
   blob written to storage is deleted when the DB insert fails, so
   outages never leave orphaned blobs or rows.
6. **Release+path immutability**: stored bytes for a release path never
   change. New bytes require a new release version.

## Storage path security

Two separate namespaces, each validated in exactly one shared home
(`@replaybug/artifacts` — API, CLI, and worker all import it, never
reimplement it):

- **User-facing `artifactPath`** (`artifact-paths.ts`): canonicalized to
  a POSIX relative path and _rejected_ (never normalized into something
  loadable) for `..` at any depth, absolute POSIX, Windows drive/UNC,
  reserved names, NUL/controls, over-long paths, trailing dot/space
  segments, and percent-encoded variants (decoded up to three rounds, so
  `%2e%2e/` and `%252e%252e/` both fail). Resolution against a real
  directory additionally proves containment (`resolveArtifactUploadPath`)
  and walks symlinks level-by-level (`assertNoSymlinkEscape`, fail-closed
  on dangling links).
- **Server-generated storage keys** (`storage-keys.ts`): layout
  `<project-id>/<release-id>/<content-hash>` (UUIDs + lowercase-hex
  SHA-256), re-validated plus containment-checked on every operation.
  The user path stays relational metadata in Postgres and is **never** a
  disk path, so traversal is impossible by design.
- **Writes** are atomic (temp file + fsync + rename, distinct temps per
  concurrent put, cleanup on every failure path). **Reads** stream;
  storage keys never appear in API responses, dashboard payloads, or
  symbolication results.

## Preflight and dedup

Preflight exists so CI uploads transfer only new bytes: the CLI scans the
build dir (deterministic order, symlink-escape guards, assets only when
associated with a collected map), asks for verdicts, skips `exists`,
uploads `upload`, and aborts before any transfer on `conflict`. The
server treats preflight as a hint: upload re-hashes, re-validates, and
re-checks the row, so a stale or lying manifest cannot corrupt stored
bytes.

## Symbolication lookup algorithm

Worker-side (`apps/worker/src/symbolication/`, maintained
`@jridgewell/trace-mapping` — no custom VLQ, no network). Per generated
artifact path within one release, in order:

1. The uploaded minified asset's trailing `sourceMappingURL` comment —
   **only** when it is a relative local same-release reference. Remote
   values (`http:`/`https:`/`file:`/`ftp:`/`data:`, protocol-relative
   `//`, any `scheme:`) are recognized and ignored, never fetched.
2. The exact sibling `<generated-path>.map`.
3. Another same-release map **only** when its metadata proves
   correspondence (the map's `file` hint resolves back to the generated
   path) — never fuzzy-matched.

Supporting rules:

- **Generated-URL normalization** (`normalize.ts`): strip origin, query,
  and fragment; keep hashed asset names verbatim
  (`assets/index-C8bf2.js` — the exact uploaded path is required; hash
  normalization belongs to fingerprinting, never to lookup).
  `data:`/`blob:` URLs, escapes, and backslashes yield no lookup.
- **Reference resolution** (`source-mapping-url.ts`): relative-local
  only, with above-root `..` escapes rejected _before_ normalization
  (which would otherwise clamp them silently).
- **Column semantics** (`columns.ts`, single source of truth): browser
  frames are display coordinates (1-based line, 1-based column); v3
  generated positions are 1-based line, 0-based column. Display→generated
  (`-1`) runs once per lookup; mapped originals convert back (`+1`) so
  raw and mapped frames share one display space for the dashboard and
  fingerprinting. Off-by-one tests pin both directions.
- **Scope**: exact `(project_id, version)` release match, same-release
  maps only, symbolication outside the DB transaction. Client-submitted
  `mapped`/`source`/`symbolication` fields in payloads are ignored —
  enrichment is worker-computed only (migration `0005`
  `events.symbolication_json`).

## No external fetching

The server never fetches `repository_url`, never fetches a remote
`sourceMappingURL`, never fetches map `sources`, and never serves map
bytes to browsers (the demo build emits sibling maps for CLI upload
only; they are not publicly served). Map `sourcesContent`, when present,
is stored inertly inside the uploaded blob — never executed, never
rendered beyond escaped text.

## Raw and mapped retention

Every symbolicated event keeps **both** views in
`events.symbolication_json`: `status`, `rawFrames`, `mappedFrames`, and
`mappedFrameCount`. The issue detail view defaults to mapped with a
Source mapped/Raw toggle and honest unavailable states; raw frames stay
readable through the event view whatever the status. Dashboard release
reads expose counts and artifact metadata only — never `storage_key`,
never file contents. All artifact-derived strings render as escaped text.

## Symbolication before fingerprinting

`selectMappedFingerprintFrames` (`fingerprint-frames.ts`) implements the
canonical rule:

1. Custom developer fingerprints (Block 5) always win — this helper is
   never consulted for them.
2. When at least one useful mapped in-application frame exists
   (`mapped: true`, `inApplication: true`), fingerprinting uses mapped
   frames so generated filenames/content-hashes do not dominate grouping.
   `release` stays excluded (existing invariant), so two releases mapping
   to the same original source group into **one issue** with two
   occurrences.
3. Partial symbolication is per-position and deterministic: each mapped
   position contributes original source/symbol/line (display
   coordinates); each unmapped position contributes the raw sanitized
   fallback, in original stack order.
4. Otherwise (`no_release`, `release_not_found`, `map_not_found`,
   `invalid_map`, `storage_unavailable`, empty stacks, mapped-non-in-app
   only, length divergence) the helper returns null and derivation uses
   the raw sanitized stack exactly as before — telemetry stays
   operational, events are never poisoned.

The mapped frames reuse the `NormalizableStackFrame` shape, so the
existing top-frames/normalize path applies unchanged (in-app preferred,
top 5, columns excluded). See
[fingerprinting.md](fingerprinting.md) for the grouping rules this feeds.

## Fallback behavior

| Status                | Meaning                                                      | Dashboard                    | Grouping                |
| --------------------- | ------------------------------------------------------------ | ---------------------------- | ----------------------- |
| `mapped`              | every frame resolved                                         | mapped default, Raw toggle   | mapped frames           |
| `partially_mapped`    | some frames resolved                                         | per-position mix, Raw toggle | per-position rule above |
| `no_release`          | event carries no release                                     | raw, honest empty state      | raw                     |
| `release_not_found`   | version not registered (telemetry may predate it)            | raw                          | raw                     |
| `map_not_found`       | no map for the generated path                                | raw                          | raw                     |
| `invalid_map`         | stored bytes fail v3 validation / trace-mapping construction | raw                          | raw                     |
| `storage_unavailable` | blob unreadable (outage, lost file)                          | raw, outage note             | raw                     |

Storage outage, end to end (proven by
`storage-outage.integration.test.ts` on real PG + FS + the real worker
path): ingest still accepts (202) with a durable outbox row, the worker
processes to `storage_unavailable` with issues still created, dashboard
reads and SSE keep working, upload fails safe with
`503 ARTIFACT_STORAGE_UNAVAILABLE` and no row — and after recovery, new
events map genuinely again while outage-era history keeps its honest
status.

## Limitations

- Only basic (non-index) Source Map v3 maps are consumed.
- Frames from `data:`/`blob:` URLs, empty filenames, and non-positive
  lines cannot name an artifact and stay raw.
- Grouping still uses at most the top in-app frames with columns
  excluded — mapped columns improve display precision, not grouping
  granularity.
- `sourcesContent` is not rendered as code context; there are no code
  snippets, auto-fixes, or external fetches by design.
- **Retention is not artifact cleanup.** Per-project retention deletes only
  eligible raw telemetry events and sessions; it does not delete release blobs.
  Confirmed project/workspace deletion queues canonical artifact keys in a
  durable outbox, then the worker deletes local files with retry/idempotence.
  Back up the volume with PostgreSQL until a deliberate deletion is completed;
  see [Self-hosting](../self-hosting.md).
