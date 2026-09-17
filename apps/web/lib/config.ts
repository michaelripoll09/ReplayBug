/**
 * Web config boundary: `NEXT_PUBLIC_REPLAYBUG_API_URL` is validated ONCE here.
 * Dev web 3000 / api 4001; prod stays reverse-proxy friendly (same-origin
 * relative URL allowed). No secrets may live in NEXT_PUBLIC_*.
 */

const DEFAULT_DEV_API_URL = "http://localhost:4001";

function normalizeApiUrl(raw: string | undefined): string {
  const candidate = (raw ?? "").trim() || DEFAULT_DEV_API_URL;
  // Allow same-origin relative base (reverse-proxy friendly).
  if (candidate.startsWith("/")) {
    return candidate.replace(/\/+$/, "") || "/";
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Invalid NEXT_PUBLIC_REPLAYBUG_API_URL: must be an absolute URL or a same-origin path",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "Invalid NEXT_PUBLIC_REPLAYBUG_API_URL: only http(s) URLs are allowed",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export interface WebConfig {
  readonly apiUrl: string;
  readonly isProduction: boolean;
}

let cached: WebConfig | null = null;

/** Validated web runtime config (memoized). Throws on invalid env. */
export function getWebConfig(): WebConfig {
  if (cached !== null) {
    return cached;
  }
  cached = {
    apiUrl: normalizeApiUrl(process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"]),
    isProduction: process.env["NODE_ENV"] === "production",
  };
  return cached;
}

/** Test-only reset for the memoized config. */
export function resetWebConfigForTests(): void {
  cached = null;
}
