/**
 * RS-07 CLI configuration: `--api-url` or `REPLAYBUG_API_URL`, auth ONLY
 * via `REPLAYBUG_AUTH_TOKEN`.
 *
 * There is deliberately no `--token` flag: a token on the command line
 * leaks via shell history and the process list. A missing token fails
 * fast with an actionable message that never echoes any credential.
 */
import { CliError } from "./errors.js";

export const AUTH_TOKEN_ENV_VAR = "REPLAYBUG_AUTH_TOKEN";
export const API_URL_ENV_VAR = "REPLAYBUG_API_URL";
export const DEBUG_ENV_VAR = "REPLAYBUG_DEBUG";

/** Local default when neither `--api-url` nor the env var is set. */
export const DEFAULT_API_URL = "http://localhost:4001";

const MISSING_TOKEN_HINT =
  "Create a secret token in Project Settings → Secret tokens and export it before retrying.";

function missingTokenError(): CliError {
  return new CliError(
    `Missing ${AUTH_TOKEN_ENV_VAR}. Set it to a secret project token (rb_sk_…) — the CLI never accepts a --token flag because tokens on the command line leak via shell history and the process list.`,
    { hint: MISSING_TOKEN_HINT },
  );
}

/** Read the bearer token or throw an actionable `CliError`. */
export function requireAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[AUTH_TOKEN_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    throw missingTokenError();
  }
  return raw;
}

/**
 * Resolve the API base URL: explicit `--api-url` wins, then
 * `REPLAYBUG_API_URL`, then the local default. Only http/https URLs
 * are accepted; anything else is a configuration error.
 */
export function resolveApiUrl(
  optionValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    optionValue !== undefined && optionValue.trim() !== ""
      ? optionValue.trim()
      : (env[API_URL_ENV_VAR]?.trim() ?? "");
  const candidate = raw === "" ? DEFAULT_API_URL : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CliError(
      `Invalid API URL "${candidate}". Use an http(s) URL via --api-url or ${API_URL_ENV_VAR}.`,
      {
        hint: `Example: --api-url http://localhost:4001 (current default ${DEFAULT_API_URL}).`,
      },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(
      `Invalid API URL "${candidate}". Only http:// and https:// URLs are supported.`,
      {
        hint: `Example: --api-url http://localhost:4001 (current default ${DEFAULT_API_URL}).`,
      },
    );
  }
  return candidate.replace(/\/+$/, "");
}
