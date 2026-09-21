import { describe, expect, it } from "vitest";
import {
  API_URL_ENV_VAR,
  AUTH_TOKEN_ENV_VAR,
  DEFAULT_API_URL,
  requireAuthToken,
  resolveApiUrl,
} from "./config.js";
import { CliError } from "./errors.js";

describe("CLI config", () => {
  it("prefers --api-url over the environment", () => {
    expect(
      resolveApiUrl("http://cli.example:4001/", {
        [API_URL_ENV_VAR]: "http://env.example:4001",
      }),
    ).toBe("http://cli.example:4001");
  });

  it("falls back to REPLAYBUG_API_URL and then the local default", () => {
    expect(resolveApiUrl(undefined, {})).toBe(DEFAULT_API_URL);
    expect(
      resolveApiUrl(undefined, { [API_URL_ENV_VAR]: "https://api.example" }),
    ).toBe("https://api.example");
    expect(resolveApiUrl("", { [API_URL_ENV_VAR]: "" })).toBe(DEFAULT_API_URL);
  });

  it("rejects non-http(s) and malformed API URLs", () => {
    for (const bad of ["notaurl", "ftp://files.example", "ws://api.example"]) {
      let error: unknown;
      try {
        resolveApiUrl(bad, {});
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("Invalid API URL");
    }
  });

  it("requires REPLAYBUG_AUTH_TOKEN with an actionable message", () => {
    for (const env of [{}, { [AUTH_TOKEN_ENV_VAR]: "   " }]) {
      let error: unknown;
      try {
        requireAuthToken(env);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CliError);
      const message = (error as CliError).message;
      expect(message).toContain(AUTH_TOKEN_ENV_VAR);
      expect(message).toContain("--token");
      expect(message).toContain("rb_sk_");
    }
  });

  it("returns the token verbatim without echoing it in errors", () => {
    const token = "rb_sk_unit_test_token_value";
    expect(requireAuthToken({ [AUTH_TOKEN_ENV_VAR]: token })).toBe(token);
  });
});
