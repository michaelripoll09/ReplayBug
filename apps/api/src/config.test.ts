import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARTIFACT_MAX_FILE_BYTES } from "@replaybug/artifacts";
import { loadApiConfigFromEnv } from "./config.js";

describe("loadApiConfigFromEnv", () => {
  const baseEnv = {
    REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
    REPLAYBUG_USER_HMAC_SECRET: "test-hmac-secret-0123456789abcdef0123456789",
  };

  function errorMessage(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected configuration loading to throw");
  }

  it("loads defaults with only the database URL set", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.port).toBe(4001);
    expect(config.environment).toBe("development");
    expect(config.webUrl).toBe("http://localhost:3000");
    expect(config.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("fails fast with a readable message when the database URL is missing", () => {
    expect(() =>
      loadApiConfigFromEnv({
        REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
      }),
    ).toThrow(/Invalid API configuration/);
  });

  it("fails fast when the auth secret is missing or too short", () => {
    expect(() =>
      loadApiConfigFromEnv({
        REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
      }),
    ).toThrow(/Invalid API configuration/);
    expect(() =>
      loadApiConfigFromEnv({
        REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
        REPLAYBUG_AUTH_SECRET: "short",
      }),
    ).toThrow(/REPLAYBUG_AUTH_SECRET/);
  });

  it("allows local placeholder secrets outside production", () => {
    const config = loadApiConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
      REPLAYBUG_AUTH_SECRET:
        "replace-this-local-development-auth-secret-before-production",
      REPLAYBUG_USER_HMAC_SECRET:
        "replace-this-local-development-hmac-secret-before-production",
    });
    expect(config.nodeEnv).toBe("development");
  });

  it("allows documented local-development placeholders outside production", () => {
    const config = loadApiConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
      REPLAYBUG_AUTH_SECRET: "local-dev-secret-0123456789abcdef0123456789",
      REPLAYBUG_USER_HMAC_SECRET:
        "local-dev-hmac-secret-0123456789abcdef0123456789ab",
    });
    expect(config.nodeEnv).toBe("development");
  });

  it("rejects the local auth placeholder in production without exposing it", () => {
    const placeholder =
      "replace-this-local-development-auth-secret-before-production";
    const message = errorMessage(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        NODE_ENV: "production",
        REPLAYBUG_AUTH_SECRET: placeholder,
      }),
    );
    expect(message).toMatch(
      /REPLAYBUG_AUTH_SECRET must not use a known development placeholder/,
    );
    expect(message).not.toContain(placeholder);
  });

  it("rejects the documented local auth placeholder in production without exposing it", () => {
    const placeholder = "local-dev-secret-0123456789abcdef0123456789";
    const message = errorMessage(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        NODE_ENV: "production",
        REPLAYBUG_AUTH_SECRET: placeholder,
      }),
    );
    expect(message).toMatch(
      /REPLAYBUG_AUTH_SECRET must not use a known development placeholder/,
    );
    expect(message).not.toContain(placeholder);
  });

  it("rejects the local HMAC placeholder in production without exposing it", () => {
    const placeholder =
      "replace-this-local-development-hmac-secret-before-production";
    const message = errorMessage(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        NODE_ENV: "production",
        REPLAYBUG_USER_HMAC_SECRET: placeholder,
      }),
    );
    expect(message).toMatch(
      /REPLAYBUG_USER_HMAC_SECRET must not use a known development placeholder/,
    );
    expect(message).not.toContain(placeholder);
  });

  it("rejects the documented local HMAC placeholder in production without exposing it", () => {
    const placeholder = "local-dev-hmac-secret-0123456789abcdef0123456789ab";
    const message = errorMessage(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        NODE_ENV: "production",
        REPLAYBUG_USER_HMAC_SECRET: placeholder,
      }),
    );
    expect(message).toMatch(
      /REPLAYBUG_USER_HMAC_SECRET must not use a known development placeholder/,
    );
    expect(message).not.toContain(placeholder);
  });

  it("accepts strong production secrets", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      NODE_ENV: "production",
      REPLAYBUG_AUTH_SECRET:
        "production-auth-secret-0123456789abcdef0123456789",
      REPLAYBUG_USER_HMAC_SECRET:
        "production-hmac-secret-0123456789abcdef0123456789",
    });
    expect(config.nodeEnv).toBe("production");
  });

  it("rejects an invalid port", () => {
    expect(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_API_PORT: "99999",
      }),
    ).toThrow(/Invalid API configuration/);
  });

  it("keeps GitHub OAuth disabled when both provider values are absent", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.github).toBeUndefined();
  });

  it("enables GitHub OAuth only when both provider values are configured", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      GITHUB_CLIENT_ID: "github-client-id",
      GITHUB_CLIENT_SECRET: "github-client-secret",
    });
    expect(config.github).toEqual({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
    });
  });

  it.each([
    { GITHUB_CLIENT_ID: "github-client-id" },
    { GITHUB_CLIENT_SECRET: "github-client-secret" },
  ])(
    "fails fast when exactly one GitHub provider value is configured",
    (githubEnv) => {
      expect(() => loadApiConfigFromEnv({ ...baseEnv, ...githubEnv })).toThrow(
        /GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together/,
      );
    },
  );

  it("accepts disabled Ollama settings without breaking startup", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.ollamaUrl).toBeUndefined();
    expect(config.ollamaModel).toBeUndefined();
    expect(config.ollamaTimeoutMs).toBeUndefined();
  });

  it("parses optional Ollama timeout", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_TIMEOUT_MS: "45000",
    });
    expect(config.ollamaTimeoutMs).toBe(45000);
  });

  it("reports AI analysis disabled when Ollama env is absent", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.aiAnalysis).toEqual({
      status: "disabled",
      configured: false,
    });
  });

  it("reports AI analysis misconfigured when only URL is set", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://localhost:11434",
    });
    expect(config.aiAnalysis).toEqual({
      status: "misconfigured",
      configured: false,
    });
  });

  it("reports AI analysis misconfigured when only model is set", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_MODEL: "llama3.2",
    });
    expect(config.aiAnalysis).toEqual({
      status: "misconfigured",
      configured: false,
    });
  });

  it("reports AI analysis configured with the sanitized model", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://localhost:11434",
      REPLAYBUG_OLLAMA_MODEL: "llama3.2",
    });
    expect(config.aiAnalysis).toEqual({
      status: "configured",
      configured: true,
      model: "llama3.2",
    });
  });

  it("invalid Ollama timeout does not fail startup and yields misconfigured", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://localhost:11434",
      REPLAYBUG_OLLAMA_MODEL: "llama3.2",
      REPLAYBUG_OLLAMA_TIMEOUT_MS: "500",
    });
    expect(config.aiAnalysis).toEqual({
      status: "misconfigured",
      configured: false,
    });
  });

  it("defaults the artifact per-file cap to 25 MiB", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.artifactMaxFileBytes).toBe(DEFAULT_ARTIFACT_MAX_FILE_BYTES);
  });

  it("rejects an invalid artifact per-file cap", () => {
    expect(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_ARTIFACT_MAX_FILE_BYTES: "0",
      }),
    ).toThrow(/Invalid API configuration/);
    expect(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_ARTIFACT_MAX_FILE_BYTES: "not-a-number",
      }),
    ).toThrow(/Invalid API configuration/);
  });

  it("accepts an explicit artifact dir that is a safe absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "replaybug-config-test-"));
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_ARTIFACT_DIR: dir,
    });
    expect(config.artifactDir).toBe(dir);
  });

  it("fails fast on an unsafe explicit artifact dir", () => {
    expect(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_ARTIFACT_DIR: "packages/evil",
      }),
    ).toThrow(/REPLAYBUG_ARTIFACT_DIR/);
    expect(() =>
      loadApiConfigFromEnv({ ...baseEnv, REPLAYBUG_ARTIFACT_DIR: "/" }),
    ).toThrow(/REPLAYBUG_ARTIFACT_DIR/);
  });

  it("merges explicit trusted origins with the web URL", () => {
    const config = loadApiConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_WEB_URL: "http://localhost:3000",
      REPLAYBUG_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:5173",
    });
    expect(config.trustedOrigins).toContain("http://localhost:3000");
    expect(config.trustedOrigins).toContain("http://localhost:5173");
  });
});
