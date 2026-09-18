import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_PROTOCOL_VERSION, SDK_VERSION, init } from "./index.js";
import { parseDsn } from "./config.js";

describe("@replaybug/sdk foundation metadata", () => {
  it("exposes a semver SDK version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes the package name and protocol version", () => {
    expect(SDK_NAME).toBe("@replaybug/sdk");
    expect(SDK_PROTOCOL_VERSION).toBe(1);
  });

  it("exports init() function", () => {
    expect(typeof init).toBe("function");
  });
});

describe("parseDsn", () => {
  it("does not duplicate the ingest path for canonical DSNs", () => {
    const parsed = parseDsn(
      "http://rb_pk_deadbeef_key@localhost:4001/api/ingest/v1",
    );
    expect(parsed.baseUrl).toBe("http://localhost:4001");
    expect(parsed.publicKey).toBe("rb_pk_deadbeef_key");
    // Transport appends /api/ingest/v1/batch to the base URL.
    expect(`${parsed.baseUrl}/api/ingest/v1/batch`).toBe(
      "http://localhost:4001/api/ingest/v1/batch",
    );
  });

  it("accepts DSNs without the ingest path and with a self-hosted prefix", () => {
    expect(parseDsn("https://rb_pk_x_key@example.com").baseUrl).toBe(
      "https://example.com",
    );
    expect(
      parseDsn("https://rb_pk_x_key@example.com/replaybug/api/ingest/v1")
        .baseUrl,
    ).toBe("https://example.com/replaybug");
  });

  it("rejects DSNs without a public key", () => {
    expect(() => parseDsn("https://example.com/api/ingest/v1")).toThrow(
      /public key/,
    );
  });
});
