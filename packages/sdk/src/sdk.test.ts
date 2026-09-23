// @vitest-environment node

import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SDK_NAME,
  SDK_PROTOCOL_VERSION,
  SDK_VERSION,
  captureException,
  init,
} from "./index.js";
import {
  parseDsn,
  type BatchPayload,
  type ClientEvent,
  type Transport,
} from "./config.js";
import { EventQueue } from "./queue.js";

describe("@replaybug/sdk foundation metadata", () => {
  it("keeps SDK_VERSION equal to the package version", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson).toEqual(
      expect.objectContaining({ version: SDK_VERSION }),
    );
  });

  it("exposes a semver SDK version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes the package name and protocol version", () => {
    expect(SDK_NAME).toBe("@replaybug/sdk");
    expect(SDK_PROTOCOL_VERSION).toBe(1);
  });

  it("emits batch metadata from the canonical SDK constants", async () => {
    const batches: BatchPayload[] = [];
    const transport: Transport = {
      async send(batch) {
        batches.push(batch);
        return {
          accepted: batch.events.length,
          duplicate: 0,
          rejected: 0,
          request_id: "metadata-test",
        };
      },
      async close() {},
    };
    const queue = new EventQueue({ transport, flushIntervalMs: 60_000 });
    const event: ClientEvent = {
      event_id: "metadata-event",
      sequence_number: 1,
      event_type: "custom",
      timestamp: "2025-01-01T00:00:00.000Z",
      tags: {},
      context: {},
      breadcrumbs: [],
      payload: {},
    };

    try {
      expect(queue.enqueue(event)).toBe(true);
      await queue.flush();

      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        protocol_version: SDK_PROTOCOL_VERSION,
      });
    } finally {
      await queue.close();
    }
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

describe("custom fingerprint on manual capture", () => {
  const captured: ClientEvent[] = [];

  beforeAll(() => {
    init({
      dsn: "http://rb_pk_test_key@localhost:4001/api/ingest/v1",
      debug: false,
      beforeSend: (event) => {
        captured.push(event);
        return null;
      },
    });
  });

  beforeEach(() => {
    captured.length = 0;
  });

  function exceptionPayloadOfLastEvent(): Record<string, unknown> {
    const exception = captured.find(
      (event) => event.event_type === "exception",
    );
    expect(exception).toBeDefined();
    return exception?.payload as Record<string, unknown>;
  }

  it("attaches a trimmed, bounded fingerprint array", () => {
    captureException(new Error("boom"), { scenario: "test" }, [
      "checkout",
      "payment  step",
      "",
      "x".repeat(400),
      "fifth",
      "sixth",
    ]);
    const payload = exceptionPayloadOfLastEvent();
    expect(payload["fingerprint"]).toEqual([
      "checkout",
      "payment step",
      "x".repeat(256),
      "fifth",
      "sixth",
    ]);
  });

  it("omits the fingerprint when nothing usable remains", () => {
    captureException(new Error("boom"), undefined, ["", "   "]);
    const payload = exceptionPayloadOfLastEvent();
    expect(payload["fingerprint"]).toBeUndefined();
  });

  it("keeps automatic grouping when no fingerprint is provided", () => {
    captureException(new Error("boom"));
    const payload = exceptionPayloadOfLastEvent();
    expect(payload["fingerprint"]).toBeUndefined();
    const values = payload["values"] as Array<Record<string, unknown>>;
    expect(values[0]?.["value"]).toBe("boom");
  });

  it("redacts secrets inside custom fingerprint items", () => {
    captureException(new Error("boom"), undefined, [
      "api_key=abcdefghijklmnopqrst",
    ]);
    const payload = exceptionPayloadOfLastEvent();
    const fingerprint = payload["fingerprint"] as string[];
    expect(fingerprint[0]).toContain("[REDACTED]");
    expect(fingerprint[0]).not.toContain("abcdefghijklmnopqrst");
  });
});
