/**
 * @replaybug/api-client — foundation boundary stub.
 *
 * Strategy (per master spec section 7.2 / 46): the future typed dashboard
 * client will be derived from the Fastify OpenAPI document using
 * `openapi-fetch` + `openapi-typescript` so client types cannot drift from
 * the server schemas. That generator wiring arrives with the first real
 * business endpoints.
 *
 * Until then this package intentionally exports only a minimal, honest
 * placeholder. It does not invent resource types for workspaces, projects,
 * issues or sessions.
 */

export interface ApiClientOptions {
  baseUrl: string;
}

export interface ApiClient {
  readonly baseUrl: string;
}

/** Create a minimal API client handle carrying the configured base URL. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const normalized = options.baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error("createApiClient requires a non-empty baseUrl");
  }
  return { baseUrl: normalized };
}
