import { describe, expect, it } from "vitest";
import { loadApiConfigFromEnv } from "./config.js";

describe("loadApiConfigFromEnv", () => {
  const baseEnv = {
    REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    REPLAYBUG_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
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
