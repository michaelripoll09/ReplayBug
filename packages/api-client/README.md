# `@replaybug/api-client`

Foundation boundary for the future typed dashboard client.

## Strategy

The real client will be generated from the Fastify OpenAPI document so
frontend types cannot drift from server schemas:

- `apps/api` emits OpenAPI from Zod route schemas (`@fastify/swagger`).
- `openapi-typescript` generates types from the committed OpenAPI JSON.
- `openapi-fetch` provides the lightweight typed fetch wrapper.

## Current state

Only `createApiClient({ baseUrl })` exists as an honest placeholder. No
resource methods or domain types are invented until the first business
endpoints land.
