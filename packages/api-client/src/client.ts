import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema.js";
import { normalizeApiError, type NormalizeErrorInput } from "./errors.js";

export type ReplayBugApiPaths = paths;
export type ReplayBugFetchClient = Client<paths>;

export interface CreateReplayBugApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch | undefined;
  /** Override credentials (default "include" so HttpOnly session cookies flow). */
  credentials?: RequestCredentials | undefined;
}

export interface ReplayBugApiClient {
  readonly baseUrl: string;
  readonly client: ReplayBugFetchClient;
  /**
   * Unwrap an openapi-fetch result: return `data` on success, throw a
   * normalized {@link ApiError} on failure. Keeps call sites tiny and
   * guarantees the envelope shape everywhere.
   */
  unwrap<T>(result: {
    data: T | undefined;
    error: unknown;
    response: Response;
  }): Promise<T>;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new Error("createReplayBugApiClient requires a non-empty baseUrl");
  }
  return normalized;
}

/**
 * Create the typed ReplayBug dashboard API client.
 *
 * - Types derive from `openapi/openapi.json` via `src/schema.d.ts`
 *   (regenerate with `pnpm api:generate`; CI fails on drift).
 * - `credentials: "include"` by default so Better Auth HttpOnly cookies are
 *   sent on same-origin and trusted cross-origin dashboard calls.
 * - Failures normalize to `{code,message,requestId,details}` via
 *   {@link normalizeApiError} with a safe fallback.
 */
export function createReplayBugApiClient(
  options: CreateReplayBugApiClientOptions,
): ReplayBugApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const credentials: RequestCredentials = options.credentials ?? "include";
  const clientOptions: Parameters<typeof createClient<paths>>[0] = {
    baseUrl,
    credentials,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
  const client = createClient<paths>(clientOptions);
  return {
    baseUrl,
    client,
    async unwrap<T>(result: {
      data: T | undefined;
      error: unknown;
      response: Response;
    }): Promise<T> {
      if (result.error === undefined || result.error === null) {
        return result.data as T;
      }
      const requestId =
        result.response.headers.get("x-request-id") ?? undefined;
      const input: NormalizeErrorInput = {
        status: result.response.status,
        body: result.error,
        ...(requestId !== undefined ? { fallbackRequestId: requestId } : {}),
      };
      throw normalizeApiError(input);
    },
  };
}
