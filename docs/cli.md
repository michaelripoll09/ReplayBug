# ReplayBug CLI — Releases and Source Maps (Block 7)

The `replaybug` CLI manages releases and uploads source maps from CI or a
developer machine. It authenticates with a **secret project token** over
`Authorization: Bearer` and never touches dashboard session cookies.

> Token placeholder convention: examples below use
> `rb_sk_<redacted>` or `$REPLAYBUG_AUTH_TOKEN`. Never paste a real token
> into docs, tickets, shell history files, or CI logs.

## Install and run

Build the workspace once, then run the binary:

```bash
pnpm build
node packages/cli/bin/replaybug.js --version
```

The binary is a thin launcher over the built `commander` program
(`packages/cli`); all logic lives in `dist/`, so a fresh checkout needs
`pnpm install --frozen-lockfile` plus a build before the binary works.

## Configuration

| Setting      | Flag                 | Environment            | Default                 |
| ------------ | -------------------- | ---------------------- | ----------------------- |
| API base URL | `--api-url <url>`    | `REPLAYBUG_API_URL`    | `http://localhost:4001` |
| Secret token | _(none — by design)_ | `REPLAYBUG_AUTH_TOKEN` | _(required)_            |

Precedence for the URL: explicit `--api-url` wins, then
`REPLAYBUG_API_URL`, then the local default. Only `http(s)` URLs are
accepted.

There is intentionally **no `--token` flag**: a token on the command line
leaks via shell history and the process list. A missing
`REPLAYBUG_AUTH_TOKEN` fails fast with an actionable message that never
echoes any credential. Extra safety properties:

- The token travels only in the `Authorization` header; the CLI never
  sends credentials in query strings.
- The CLI never logs or prints the token (safe errors carry the server
  `requestId`, never a stack trace by default; `REPLAYBUG_DEBUG=1` prints
  stacks but still never the token).

## projects info

Verify the token and show the project it belongs to:

```bash
export REPLAYBUG_AUTH_TOKEN='rb_sk_<redacted>'
node packages/cli/bin/replaybug.js projects info
node packages/cli/bin/replaybug.js projects info --json
```

Human output prints project name/slug/id, workspace, and timezone; `--json`
prints the same record as JSON. Minimum fields only — the endpoint is
`GET /api/v1/cli/project` and the caller is a project-scoped principal,
never a dashboard user.

## releases create / list

```bash
node packages/cli/bin/replaybug.js releases create 'web@1.4.2' \
  --commit-sha 9f3c2ab1 --repository-url https://github.com/acme/storefront
node packages/cli/bin/replaybug.js releases list
node packages/cli/bin/replaybug.js releases list --json
```

Release identity rules (shared with `POST /api/v1/cli/releases`):

- `version`: 1–128 chars, never trimmed, exact-match unique per project.
  Not semver-restricted — `web@1.4.2`, `demo@2026.09.18`, and `1.4.2`
  are all valid.
- `--commit-sha`: optional 7–64 hex chars, recorded for traceability.
- `--repository-url`: optional `http(s)` URL, recorded only — the server
  never fetches it (no SSRF surface).
- Create is **idempotent**: re-creating with identical metadata returns
  the existing release with `created: false` (HTTP 200). Re-creating the
  same version with _different_ identity metadata is
  `409 RELEASE_VERSION_CONFLICT` and the stored row is left untouched.
- List order is deterministic (`created_at`, then version) and carries
  artifact counts.

## sourcemaps upload

```bash
node packages/cli/bin/replaybug.js sourcemaps upload ./dist --release 'web@1.4.2'
node packages/cli/bin/replaybug.js sourcemaps upload ./dist --release 'web@1.4.2' --json
```

What the command does, in order:

1. **Scan** `./dist` recursively (deterministic order) for `.map` files
   plus their associated generated assets (`.js`/`.mjs`/`.cjs`). An asset
   is collected only when it is associated with a collected map: a
   sibling `<asset>.map`, a safe map `file`-hint, or the asset's own
   `sourceMappingURL` comment pointing at a collected map. Remote
   references (`http:`, `//`, `data:`) are never fetched.
2. **Symlink guard**: every path proves containment via
   `canonicalizeArtifactPath` + `assertNoSymlinkEscape`. Symlink escapes,
   dangling links, and symlinked directories are skipped with a warning
   on stderr — never followed, never uploaded.
3. **Create-or-confirm** the release (idempotent; a
   `RELEASE_VERSION_CONFLICT` falls back to confirming via the list).
4. **Preflight** (`POST /api/v1/cli/releases/:version/artifacts/check`):
   per-artifact verdicts — `upload` (not stored), `exists` (same
   path+hash stored), `conflict` (same path, different bytes). The
   manifest is bounded (~500 entries, ~250 MiB aggregate).
5. **Upload** each `upload` verdict as multipart with server-side SHA-256
   - size. `exists` files are skipped (second uploads of identical bytes
     transfer nothing). Any `conflict` aborts the whole run **before**
     uploading anything: stored bytes are never overwritten, and the CLI
     prints which paths differ with a hint to restore matching contents or
     cut a new release version.
6. **Summary**: found source maps / minified assets, uploaded count,
   already-present count (JSON shape under `--json`).

Server-side upload policy (the CLI cannot override any of it):

- Per-file cap 25 MiB default (`REPLAYBUG_ARTIFACT_MAX_FILE_BYTES`),
  enforced by multipart limits before unbounded buffering.
- Extension allowlist `.map`/`.js`/`.mjs`/`.cjs`; realistic CLI multipart
  MIME types tolerated, dangerous content sniffed (executables, markup).
- `.map` bytes must validate as Source Map v3 (`400 INVALID_SOURCE_MAP`
  otherwise, with no row and no stored file).
- Paths canonicalize to POSIX relative form; traversal, absolute, drive,
  UNC, reserved-name, and encoded variants are rejected.
- Same path + same hash is idempotent (`200 created: false`);
  same path + different bytes is `409 ARTIFACT_PATH_CONFLICT`.
- Storage outage fails safe: `503 ARTIFACT_STORAGE_UNAVAILABLE` with no
  row stored.

## Errors

Failures render as `Error: <message>` plus `Request ID: <id>` when the
server reported one, plus a `Hint:` line when available. Include the
request ID (never the token) when asking for support.

## CI example

Keep the token in the CI provider's **secret store** (GitHub: an
environment secret), never in the workflow file:

```yaml
jobs:
  sourcemaps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.17.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build # emits ./dist plus sibling .map files
      - run: node packages/cli/bin/replaybug.js releases create "$RELEASE" --commit-sha "$GITHUB_SHA"
        env:
          REPLAYBUG_API_URL: ${{ vars.REPLAYBUG_API_URL }}
          REPLAYBUG_AUTH_TOKEN: ${{ secrets.REPLAYBUG_AUTH_TOKEN }}
      - run: node packages/cli/bin/replaybug.js sourcemaps upload ./dist --release "$RELEASE"
        env:
          REPLAYBUG_API_URL: ${{ vars.REPLAYBUG_API_URL }}
          REPLAYBUG_AUTH_TOKEN: ${{ secrets.REPLAYBUG_AUTH_TOKEN }}
```

Notes:

- The token is injected via `env:` from a secret — it never appears in
  the workflow file, in `run:` lines, or in logs (the CLI never prints
  it, even on failure).
- Uploads are idempotent: re-running a job skips already-stored bytes
  (`already-present`) instead of re-transferring them.
- A revoked token fails every command with `401` (rotate in
  Project Settings → Secret tokens and update the CI secret).

## Secret-token lifecycle

Tokens are created in the dashboard under
Project Settings → Secret tokens (owner/admin only,
`project:manage-secret-tokens` capability):

- **One-time reveal**: the full `rb_sk_…` token appears exactly once in
  the creation response/modal (with copy support). It is never shown
  again, never persisted to `localStorage`/`sessionStorage`/URL/cache,
  and cleared on modal close. Only hash + prefix stay server-side.
- **Metadata**: list views show name, prefix, creation, `last_used_at`,
  and revocation state — never the token or its hash.
- **Revocation**: immediate; in-flight CLI runs fail with `401` on their
  next request. Audit logs record management actions without
  plaintext/hash material.
- **Compromise response**: revoke the token, create a replacement, update
  CI secrets. Because tokens are project-scoped, rotation affects one
  project's automation only.
