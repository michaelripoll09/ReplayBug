"use client";

import { createReplayBugApiClient } from "@replaybug/api-client";
import { getWebConfig } from "./config";

/**
 * Browser singleton for the typed OpenAPI client.
 * `credentials: "include"` so the HttpOnly Better Auth cookie is sent.
 * For server components use `lib/auth-server.ts` (cookie-forwarding fetch),
 * never this singleton.
 */

let cachedBaseUrl: string | null = null;

function baseUrl(): string {
  if (cachedBaseUrl !== null) {
    return cachedBaseUrl;
  }
  try {
    cachedBaseUrl = getWebConfig().apiUrl;
  } catch {
    cachedBaseUrl = "http://localhost:4001";
  }
  return cachedBaseUrl;
}

export const api = createReplayBugApiClient({ baseUrl: baseUrl() });

export function getApiBaseUrl(): string {
  return baseUrl();
}
