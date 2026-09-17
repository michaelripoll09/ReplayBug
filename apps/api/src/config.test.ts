import { describe, expect, it } from "vitest";
import { loadApiConfigFromEnv } from "./config.js";

describe("loadApiConfigFromEnv", () => {
  it("loads defaults with only the database URL set", () => {
    const config = loadApiConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    });
    expect(config.port).toBe(4001);
    expect(config.environment).toBe("development");
  });

  it("fails fast with a readable message when the database URL is missing", () => {
    expect(() => loadApiConfigFromEnv({})).toThrow(/Invalid API configuration/);
  });

  it("rejects an invalid port", () => {
    expect(() =>
      loadApiConfigFromEnv({
        REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
        REPLAYBUG_API_PORT: "99999",
      }),
    ).toThrow(/Invalid API configuration/);
  });

  it("accepts disabled Ollama settings without breaking startup", () => {
    const config = loadApiConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    });
    expect(config.ollamaUrl).toBeUndefined();
  });
});
