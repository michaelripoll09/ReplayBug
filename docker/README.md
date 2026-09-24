# Full self-hosted Docker stack

`docker-compose.full.yml` is an optional, source-built self-hosting stack. It
runs PostgreSQL, the Fastify API, the background worker, the Next.js dashboard,
and the production-built Vite demo. It has no dependency on Redis, S3, a paid
service, Ollama, or GitHub.

The existing root `docker-compose.yml` remains the small local PostgreSQL-only
setup. Use this file when a complete local or self-hosted stack is wanted.

## Start workflow

Generate fresh, non-placeholder production secrets with ReplayBug's
already-supported Node 24 runtime, then set public URLs in the shell or a
deployment-managed Compose environment file. Do not commit generated values or
bake `.env` into an image. The `.env.example` placeholders are for local
`pnpm dev`; production-mode full Docker intentionally rejects them.

```bash
export REPLAYBUG_AUTH_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export REPLAYBUG_USER_HMAC_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export REPLAYBUG_WEB_URL="https://replaybug.example.com"
export REPLAYBUG_API_URL="https://api.replaybug.example.com"
export NEXT_PUBLIC_REPLAYBUG_API_URL="https://api.replaybug.example.com"
```

Build and start PostgreSQL first, then run migrations deliberately. Application
startup never runs migrations.

```bash
docker compose -f docker-compose.full.yml up -d postgres
docker compose -f docker-compose.full.yml --profile migrate run --rm migrate
docker compose -f docker-compose.full.yml up -d api worker web demo
```

`postgres`, `api`, `web`, and `demo` have healthchecks. Service dependencies
wait for the relevant healthcheck; there are no fixed startup sleeps. The
worker waits for healthy PostgreSQL and validates its database connection on
startup.

## Optional public demo seed

The public demo is disabled in the API unless `REPLAYBUG_DEMO_MODE=true`. Set
it before starting API if anonymous public-demo routes are intended, migrate
the database, then seed explicitly:

```bash
export REPLAYBUG_DEMO_MODE=true
docker compose -f docker-compose.full.yml up -d api
docker compose -f docker-compose.full.yml --profile seed-demo run --rm seed-demo
```

The seed service always supplies `REPLAYBUG_DEMO_MODE=true` to meet the seed
script's safety check. It is idempotent; use `pnpm demo:reset` outside Compose
only when intentionally replacing the synthetic demo data.

## Images and storage

`docker/Dockerfile` is target-aware and uses Node 24 with pnpm 10.17. Every
Node target installs with `pnpm install --frozen-lockfile`, builds workspace
source, and deploys only production dependencies to the API, worker, or web
runtime. The API runs built Fastify, the worker runs its built runtime, the web
runs `next start`, and the demo is served by unprivileged nginx from Vite's
production `dist` output.

The Dockerfile explicitly excludes host `node_modules`, `dist`, `.next`, and
`.env` files during source copy. Node runtimes run as the unprivileged `node`
user. API and worker both mount the same writable `replaybug-artifacts` volume
at `/var/lib/replaybug/artifacts`; do not make the worker mount read-only.

## Configuration notes

- PostgreSQL host access defaults to `localhost:5544`; API, worker, and tools
  use the internal `postgres:5432` address.
- The PostgreSQL defaults are development placeholders. Supply fresh database
  credentials and the required, freshly generated app secrets before exposing
  a deployment.
- `NEXT_PUBLIC_REPLAYBUG_API_URL` and Vite `VITE_*` values are build-time
  browser configuration. Rebuild web/demo after changing them.
- Compose forwards `REPLAYBUG_TRUSTED_ORIGINS` when supplied. Otherwise the API
  uses `REPLAYBUG_WEB_URL` as the trusted dashboard origin.
- Ollama is absent and disabled by default. Compose forwards optional Ollama
  settings to API and worker when supplied; set `REPLAYBUG_OLLAMA_URL` and
  `REPLAYBUG_OLLAMA_MODEL` together. No Ollama service is included or required,
  and core telemetry and issue grouping do not depend on it.
- GitHub integration is not required by this stack.

See [`docs/self-hosting.md`](../docs/self-hosting.md) for reverse-proxy,
backup, restore, cookie, and CORS guidance.
