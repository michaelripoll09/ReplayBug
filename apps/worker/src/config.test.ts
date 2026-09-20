import { describe, expect, it } from "vitest";
import { loadOllamaCapability, loadWorkerConfigFromEnv } from "./config.js";

const baseEnv = {
  REPLAYBUG_DATABASE_URL: "postgres://worker@example.test/replaybug",
};

describe("optional Ollama worker configuration", () => {
  it("is disabled when both URL and model are absent", () => {
    const capability = loadWorkerConfigFromEnv(baseEnv).ollama;
    expect(capability).toEqual({ state: "disabled" });
    expect(JSON.stringify(capability)).not.toContain("http");
    expect(JSON.stringify(capability)).not.toContain("REPLAYBUG");
  });

  it("is configured only with a valid URL and model", () => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://ollama:11434/base/",
      REPLAYBUG_OLLAMA_MODEL: "llama3.2:latest",
      REPLAYBUG_OLLAMA_TIMEOUT_MS: "45000",
    }).ollama;
    expect(capability).toEqual({
      state: "configured",
      baseUrl: "http://ollama:11434/base",
      model: "llama3.2:latest",
      timeoutMs: 45_000,
    });
  });

  it("defaults timeout to 30000ms when omitted", () => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://ollama:11434",
      REPLAYBUG_OLLAMA_MODEL: "llama3",
    }).ollama;
    expect(capability).toMatchObject({
      state: "configured",
      timeoutMs: 30_000,
    });
  });

  it.each([
    ["1000", 1_000],
    ["120000", 120_000],
    ["30000", 30_000],
  ])("accepts timeout boundary value %s", (raw, expected) => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://ollama:11434",
      REPLAYBUG_OLLAMA_MODEL: "llama3",
      REPLAYBUG_OLLAMA_TIMEOUT_MS: raw,
    }).ollama;
    expect(capability).toMatchObject({
      state: "configured",
      timeoutMs: expected,
    });
  });

  it.each([
    ["999", "OLLAMA_TIMEOUT_INVALID"],
    ["120001", "OLLAMA_TIMEOUT_INVALID"],
    ["0", "OLLAMA_TIMEOUT_INVALID"],
    ["not-a-number", "OLLAMA_TIMEOUT_INVALID"],
    ["", "OLLAMA_TIMEOUT_INVALID"],
    ["30000.5", "OLLAMA_TIMEOUT_INVALID"],
  ])("rejects invalid timeout %s with code %s", (raw, code) => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "http://ollama:11434",
      REPLAYBUG_OLLAMA_MODEL: "llama3",
      REPLAYBUG_OLLAMA_TIMEOUT_MS: raw,
    }).ollama;
    expect(capability).toMatchObject({ state: "misconfigured", code });
  });

  it.each([
    ["http://ollama:11434", "Docker hostname without TLD"],
    ["http://localhost:11434", "localhost"],
    ["http://127.0.0.1:11434", "loopback IP"],
    ["https://ollama.example.test/path", "HTTPS with path"],
  ])("accepts safe local URL %s (%s)", (url) => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: url,
      REPLAYBUG_OLLAMA_MODEL: "llama3",
    }).ollama;
    expect(capability).toMatchObject({
      state: "configured",
      baseUrl: url.replace(/\/$/, ""),
    });
  });

  it.each([
    [
      "only model",
      { REPLAYBUG_OLLAMA_MODEL: "llama3" },
      "OLLAMA_CONFIGURATION_INCOMPLETE",
    ],
    [
      "only URL",
      { REPLAYBUG_OLLAMA_URL: "https://ollama.example.test" },
      "OLLAMA_CONFIGURATION_INCOMPLETE",
    ],
    [
      "credentials",
      {
        REPLAYBUG_OLLAMA_URL: "https://user:pass@ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "username only",
      {
        REPLAYBUG_OLLAMA_URL: "https://user@ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "password only",
      {
        REPLAYBUG_OLLAMA_URL: "https://:pass@ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "query",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test/?token=secret",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "fragment",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test/#secret",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "query and fragment",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test/?a=1#b",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "control character in URL",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test/\n",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "control character in model",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "llama3\t",
      },
      "OLLAMA_MODEL_INVALID",
    ],
    [
      "unsupported scheme file",
      {
        REPLAYBUG_OLLAMA_URL: "file:///tmp/ollama",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "unsupported scheme ftp",
      {
        REPLAYBUG_OLLAMA_URL: "ftp://ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "unsupported scheme data",
      {
        REPLAYBUG_OLLAMA_URL: "data:text/html,hi",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      },
      "OLLAMA_URL_INVALID",
    ],
    [
      "empty model",
      {
        REPLAYBUG_OLLAMA_URL: "https://ollama.test",
        REPLAYBUG_OLLAMA_MODEL: "  ",
      },
      "OLLAMA_MODEL_INVALID",
    ],
    [
      "empty URL",
      { REPLAYBUG_OLLAMA_URL: "", REPLAYBUG_OLLAMA_MODEL: "llama3" },
      "OLLAMA_URL_INVALID",
    ],
  ])("reports safe misconfiguration for %s", (_label, overrides, code) => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      ...overrides,
    }).ollama;
    expect(capability?.state).toBe("misconfigured");
    expect(capability).toMatchObject({ code });
    const serialized = JSON.stringify(capability);
    expect(serialized).not.toContain("ollama.test");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("user:pass");
  });

  it("rejects a model longer than 256 characters", () => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "https://ollama.test",
      REPLAYBUG_OLLAMA_MODEL: "a".repeat(257),
    }).ollama;
    expect(capability).toMatchObject({
      state: "misconfigured",
      code: "OLLAMA_MODEL_INVALID",
    });
  });

  it("trims model whitespace without leaking it in the reason", () => {
    const capability = loadWorkerConfigFromEnv({
      ...baseEnv,
      REPLAYBUG_OLLAMA_URL: "https://ollama.test",
      REPLAYBUG_OLLAMA_MODEL: "  llama3  ",
    }).ollama;
    expect(capability).toMatchObject({ state: "configured", model: "llama3" });
  });

  it("never includes the configured URL or model in misconfiguration output", () => {
    const capability = loadOllamaCapability({
      REPLAYBUG_OLLAMA_URL: "https://leaked.example.test/path",
      REPLAYBUG_OLLAMA_MODEL: "secret-model",
    });
    expect(capability.state).toBe("configured");
    const misconfigured = loadOllamaCapability({
      REPLAYBUG_OLLAMA_URL: "https://leaked.example.test/path",
    });
    expect(misconfigured.state).toBe("misconfigured");
    const text = JSON.stringify(misconfigured);
    expect(text).not.toContain("leaked.example.test");
    expect(text).not.toContain("secret-model");
    expect(text).not.toContain("https://");
  });

  it("does not block startup when misconfigured", () => {
    expect(() =>
      loadWorkerConfigFromEnv({
        ...baseEnv,
        REPLAYBUG_OLLAMA_URL: "not-a-url",
        REPLAYBUG_OLLAMA_MODEL: "llama3",
      }),
    ).not.toThrow();
  });
});
