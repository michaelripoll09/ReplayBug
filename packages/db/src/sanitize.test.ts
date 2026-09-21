import { describe, expect, it } from "vitest";
import { TELEMETRY_LIMITS } from "@replaybug/contracts";
import {
  redactSecrets,
  sanitizeBatchRequest,
  sanitizeContext,
  sanitizeEventPayload,
} from "./sanitize.js";

const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BEARER_FIXTURE = "rb_test_bearer_token_abcdefghijklmnop";
const PASSWORD_FIXTURE = "Sup3rSecretPassword";
const CARD_FIXTURE = "4111111111111111";

describe("redactSecrets", () => {
  it("preserves plain text without sensitive patterns", () => {
    expect(redactSecrets("checkout failed for product 42")).toBe(
      "checkout failed for product 42",
    );
  });

  it("redacts secrets and embedded URL query params", () => {
    const input = `password=${PASSWORD_FIXTURE} at https://example.com/cb?token=leak-value-123456&ok=1`;
    const output = redactSecrets(input);
    expect(output).not.toContain(PASSWORD_FIXTURE);
    expect(output).not.toContain("leak-value-123456");
    expect(output).toContain("[REDACTED]");
  });
});

describe("sanitizeContext", () => {
  it("redacts sensitive keys and secret patterns in nested context", () => {
    const result = sanitizeContext({
      password: PASSWORD_FIXTURE,
      nested: {
        token: JWT_FIXTURE,
        note: `Authorization: Bearer ${BEARER_FIXTURE}`,
      },
      safe: "keep me",
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(PASSWORD_FIXTURE);
    expect(json).not.toContain(JWT_FIXTURE);
    expect(json).not.toContain(BEARER_FIXTURE);
    expect(json).toContain("keep me");
  });

  it("truncates beyond the maximum nesting depth", () => {
    const deep = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: "deep-value" } } } } } } },
    };
    const result = sanitizeContext(deep);
    const json = JSON.stringify(result);
    expect(json).not.toContain("deep-value");
    expect(json).toContain("max_depth_exceeded");
  });
});

describe("sanitizeEventPayload", () => {
  it("truncates messages beyond the maximum length", () => {
    const long = "m".repeat(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH + 500);
    const result = sanitizeEventPayload({ message: long });
    const message = result["message"] as string;
    expect(message.length).toBeLessThan(long.length);
    expect(message.endsWith("…")).toBe(true);
  });

  it("redacts secrets in payload strings and sensitive keys", () => {
    const result = sanitizeEventPayload({
      message: `Authorization: Bearer ${BEARER_FIXTURE}`,
      api_key: "sk_live_0123456789abcdef",
      nested: { note: JWT_FIXTURE },
      page_url: "http://localhost:5173/checkout?token=leak-value-999",
      card: CARD_FIXTURE,
      safe_field: "checkout button",
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(BEARER_FIXTURE);
    expect(json).not.toContain("sk_live_0123456789abcdef");
    expect(json).not.toContain(JWT_FIXTURE);
    expect(json).not.toContain("leak-value-999");
    expect(json).not.toContain(CARD_FIXTURE);
    expect(json).toContain("checkout button");
  });

  it("truncates stack frames to the contract maximum", () => {
    const frames = Array.from(
      { length: TELEMETRY_LIMITS.MAX_STACK_FRAMES + 1 },
      (_, i) => ({ filename: `frame-${i}.js`, function: "fn", lineno: i + 1 }),
    );
    const result = sanitizeEventPayload({
      values: [{ type: "Error", value: "boom", stacktrace: { frames } }],
    });
    const values = result["values"] as Array<Record<string, unknown>>;
    const stacktrace = values[0]?.["stacktrace"] as Record<string, unknown>;
    expect(stacktrace["frames"]).toHaveLength(
      TELEMETRY_LIMITS.MAX_STACK_FRAMES,
    );
  });
});

describe("sanitizeBatchRequest", () => {
  it("caps breadcrumbs to the contract maximum keeping the most recent", () => {
    const breadcrumbs = Array.from(
      { length: TELEMETRY_LIMITS.MAX_BREADCRUMBS + 1 },
      (_, i) => ({
        timestamp: new Date(0).toISOString(),
        type: "custom" as const,
        message: `crumb-${i}`,
        level: "info" as const,
      }),
    );
    const result = sanitizeBatchRequest({
      events: [
        {
          event_id: "00000000-0000-4000-8000-000000000000",
          sequence_number: 0,
          event_type: "exception",
          timestamp: new Date(0).toISOString(),
          payload: { values: [] },
          breadcrumbs,
        },
      ],
    }) as { events: Array<{ breadcrumbs: Array<{ message: string }> }> };

    const capped = result.events[0]?.breadcrumbs ?? [];
    expect(capped).toHaveLength(TELEMETRY_LIMITS.MAX_BREADCRUMBS);
    expect(capped[0]?.message).toBe("crumb-1");
    expect(capped[capped.length - 1]?.message).toBe(
      `crumb-${TELEMETRY_LIMITS.MAX_BREADCRUMBS}`,
    );
  });
});
