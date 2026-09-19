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

  it("rejects an invalid port", () => {
    expect(() =>
      loadApiConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_API_PORT: "99999",
      }),
    ).toThrow(/Invalid API configuration/);
  });

  it("accepts disabled Ollama settings without breaking startup", () => {
    const config = loadApiConfigFromEnv(baseEnv);
    expect(config.ollamaUrl).toBeUndefined();
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
