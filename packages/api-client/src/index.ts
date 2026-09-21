/**
 * @replaybug/api-client — typed dashboard client derived from OpenAPI.
 *
 * Source of truth: the Fastify route schemas. Regenerate with
 * `pnpm api:generate` (builds the Fastify instance in-process, calls
 * `app.swagger()`, writes `openapi/openapi.json`, then runs
 * `openapi-typescript` to `src/schema.d.ts`). Never hand-edit the generated
 * files; CI fails on drift (`pnpm api:generate` + `git diff --exit-code`).
 */

export {
  createReplayBugApiClient,
  type CreateReplayBugApiClientOptions,
  type ReplayBugApiClient,
  type ReplayBugApiPaths,
  type ReplayBugFetchClient,
} from "./client.js";
export {
  ApiError,
  normalizeApiError,
  validationDetails,
  type ApiErrorBody,
  type NormalizeErrorInput,
} from "./errors.js";

/** @deprecated Use `createReplayBugApiClient` (typed OpenAPI client). */
export interface ApiClientOptions {
  baseUrl: string;
}

/** @deprecated Use `ReplayBugApiClient`. */
export interface ApiClient {
  readonly baseUrl: string;
}

/**
 * @deprecated Minimal foundation handle. Prefer `createReplayBugApiClient`,
 * which carries the same normalized baseUrl plus the typed fetch client.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const normalized = options.baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error("createApiClient requires a non-empty baseUrl");
  }
  return { baseUrl: normalized };
}
