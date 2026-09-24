# Self-hosting ReplayBug

ReplayBug self-hosts with PostgreSQL and a local filesystem artifact volume.
The optional full Docker stack requires no Redis, S3/object storage, paid
service, Ollama, or GitHub integration. Ollama is an optional operator-managed
AI enhancement and is absent by default.

## Full Docker workflow

[`docker-compose.full.yml`](../docker-compose.full.yml) builds Node 24/pnpm
workspace source and starts PostgreSQL, API, worker, web, and demo. Images do
not copy host `node_modules`, `dist`, `.next`, or `.env` files. API and worker
share a writable artifact volume at `/var/lib/replaybug/artifacts`.

Generate fresh, non-placeholder secrets with ReplayBug's already-supported
Node 24 runtime, then set public URLs through your deployment environment (or
a non-committed Compose environment file). Do not commit generated values or
put them in image build arguments. The `.env.example` placeholders are for
local `pnpm dev`; production-mode full Docker intentionally rejects them.
Run migration as a separate, explicit operation.

```bash
export REPLAYBUG_AUTH_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export REPLAYBUG_USER_HMAC_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export REPLAYBUG_WEB_URL="https://replaybug.example.com"
export REPLAYBUG_API_URL="https://api.replaybug.example.com"
export NEXT_PUBLIC_REPLAYBUG_API_URL="https://api.replaybug.example.com"

docker compose -f docker-compose.full.yml up -d postgres
docker compose -f docker-compose.full.yml --profile migrate run --rm migrate
docker compose -f docker-compose.full.yml up -d api worker web demo
```

GitHub OAuth is optional. Full Compose forwards `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` to the API when the host supplies them; configure both
together. Email/password authentication and core operation work without any
GitHub integration. Keep OAuth credentials in deployment-managed environment
or secrets, and never commit the client secret.

Migrations are intentionally **not** run by API or worker startup. PostgreSQL,
API, web, and demo have healthchecks, and Compose dependencies wait for health
rather than using arbitrary sleeps. The worker validates PostgreSQL itself at
startup.

The dashboard's `NEXT_PUBLIC_REPLAYBUG_API_URL` and the demo's `VITE_*` values
are embedded at build time. Rebuild those images after changing their public
URLs. For a same-origin reverse proxy, set
`NEXT_PUBLIC_REPLAYBUG_API_URL=/api` before building the web image.

## Public demo (opt-in)

Anonymous public-demo reads remain disabled unless `REPLAYBUG_DEMO_MODE=true`.
After migrations, enable it for API and invoke the explicit profile utility:

```bash
export REPLAYBUG_DEMO_MODE=true
docker compose -f docker-compose.full.yml up -d api
docker compose -f docker-compose.full.yml --profile seed-demo run --rm seed-demo
```

`seed-demo` is idempotent and always receives `REPLAYBUG_DEMO_MODE=true`; it
does not run automatically. Leave the variable false or unset when the public
demo is not wanted. Set `REPLAYBUG_DEMO_PUBLIC_KEY` to the public ingestion key
used by the demo; the Compose default is a safe synthetic key for local use.

## HTTPS, cookies, and CORS

Put Caddy, nginx, or another TLS-terminating reverse proxy in front of exposed
services. Terminate HTTPS there, redirect HTTP to HTTPS, and route the web and
API under the public URLs configured above. A same-origin setup (for example,
web at `https://replaybug.example.com` and proxy `/api` to API) minimizes CORS
and cookie complexity. Do not expose PostgreSQL publicly.

Use fresh, long random values for `REPLAYBUG_AUTH_SECRET` and
`REPLAYBUG_USER_HMAC_SECRET`; development placeholders are not production
secrets. Configure `REPLAYBUG_WEB_URL` and `REPLAYBUG_API_URL` to their
externally visible HTTPS origins. Compose forwards `REPLAYBUG_TRUSTED_ORIGINS`
when the host supplies it; otherwise the API uses `REPLAYBUG_WEB_URL` as the
trusted dashboard origin. When supplied, keep it as an exact, comma-separated
allow-list of browser origins; never use `*` with credentialed requests. If web
and API are on different origins, configure CORS only for the dashboard origin
and verify Secure, HttpOnly, and SameSite cookie behavior through the proxy.
Set forwarded protocol/host headers correctly so auth never treats HTTPS
browser traffic as plain HTTP.

## Rate limiting

ReplayBug has a coarse in-memory API rate limiter per API process
(`@fastify/rate-limit`, registered globally). The default outer policy is
1000 requests / 60 seconds per IP as observed by Fastify. Exceeding it
returns `429` with a `Retry-After` header and a safe `RATE_LIMITED`
envelope (no IPs, keys, cookies, or tokens in the body).

Stricter per-route limits apply to clearly expensive or
security-sensitive operations (AI analysis creation, reproduction
generation, secret-token mutations, invitation lifecycle mutations, CLI
artifact upload, issue lifecycle mutations). Ordinary reads stay on the
global default.

Ingest retains its separate PostgreSQL project/key rate limiter
(per-minute request and event quotas with `429` + `Retry-After`),
and Better Auth retains its own auth limiter (100 requests / 60 seconds).
No Redis is required: in-memory counters are per process, so
multi-instance deployments do NOT share global limiter counters.
ReplayBug does not automatically trust `X-Forwarded-For`; operators
behind a reverse proxy should configure abuse/rate controls at the
trusted edge if they require client-IP-aware distributed enforcement.
Do not blindly enable `trustProxy` to work around this.

## Artifact storage

`REPLAYBUG_ARTIFACT_DIR` is the shared artifact root for API and worker. In the
full stack it is the persistent `replaybug-artifacts` volume mounted at
`/var/lib/replaybug/artifacts`; both processes need read/write access because
API uploads files and worker symbolicates and performs durable deletion-outbox
cleanup. A read-only worker mount is incorrect.

| Variable                                 | Meaning                       | Default                                 |
| ---------------------------------------- | ----------------------------- | --------------------------------------- |
| `REPLAYBUG_ARTIFACT_DIR`                 | Shared artifact root          | `~/.replaybug/artifacts` outside Docker |
| `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES`      | API per-file upload cap       | `26214400` (25 MiB)                     |
| `REPLAYBUG_ARTIFACT_STAGING_DIR`         | API multipart staging area    | OS temp directory                       |
| `REPLAYBUG_ARTIFACT_DELETION_BATCH_SIZE` | Worker deletion rows per pass | `100`                                   |
| `REPLAYBUG_ARTIFACT_DELETION_POLL_MS`    | Worker deletion interval      | `1000` ms                               |

Release uploads use server-generated keys
`<project-id>/<release-id>/<content-hash>`. A confirmed project or workspace
delete writes durable deletion-outbox rows in the same transaction; worker
retries failed unlinks. When storage is unavailable, ingest remains available,
source-map upload fails safely, and worker falls back to raw stacks.

## Backup and restore

Back up PostgreSQL and artifacts together. A database restore without matching
artifacts can leave source-map rows referring to unavailable files.

```bash
# Create a PostgreSQL custom-format dump through the Compose network.
docker compose -f docker-compose.full.yml exec -T postgres \
  pg_dump -U replaybug -d replaybug -Fc > replaybug-postgres.dump

# Archive the named artifact volume. Keep this archive beside the DB dump.
docker run --rm \
  -v replaybug-full_replaybug-artifacts:/artifacts:ro \
  -v "$PWD":/backup \
  alpine:3.21 tar -C /artifacts -czf /backup/replaybug-artifacts.tar.gz .

# Restore into a stopped application stack after starting only PostgreSQL.
docker compose -f docker-compose.full.yml up -d postgres
docker compose -f docker-compose.full.yml exec -T postgres \
  pg_restore -U replaybug -d replaybug --clean --if-exists < replaybug-postgres.dump

# Restore artifact bytes to the same named volume.
docker run --rm \
  -v replaybug-full_replaybug-artifacts:/artifacts \
  -v "$PWD":/backup:ro \
  alpine:3.21 tar -C /artifacts -xzf /backup/replaybug-artifacts.tar.gz
```

The actual named-volume prefix can differ when `COMPOSE_PROJECT_NAME` is set;
use `docker volume ls` and substitute the generated name. Test restore
procedures on a separate deployment before relying on them.

## Optional local Ollama analysis

Core ingest, grouping, issue detail, timelines, retention, artifact cleanup,
and deterministic reproduction do not depend on Ollama. To opt in to an
operator-managed endpoint, configure both API and worker:

```bash
REPLAYBUG_OLLAMA_URL=http://host.docker.internal:11434
REPLAYBUG_OLLAMA_MODEL=<your-local-model>
REPLAYBUG_OLLAMA_TIMEOUT_MS=30000
```

Compose forwards these optional settings to both API and worker when the host
supplies them. Set URL and model together or leave both absent; the capability
is disabled by default. ReplayBug neither downloads models nor includes or
requires a Compose Ollama service. A down, slow, or misconfigured provider
only affects AI analysis; core telemetry and issue grouping remain independent,
and provider availability does not make API readiness fail.
