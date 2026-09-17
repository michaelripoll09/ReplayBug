import { describe, expect, it } from "vitest";
import {
  sanitizeUrl,
  sanitizeString,
  sanitizeContext,
  redactSecrets,
  isSensitiveInput,
  sanitizeLocatorText,
  truncateToBytes,
  sanitizeEventPayload,
  isSensitiveParam,
  isSensitiveKey,
} from "./sanitize.js";
import { SENSITIVE_URL_PARAMS, TELEMETRY_LIMITS } from "@replaybug/contracts";

describe("sanitizeUrl", () => {
  it("preserves origin and path", () => {
    expect(sanitizeUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("redacts sensitive query parameters", () => {
    expect(sanitizeUrl("https://example.com/path?token=secret123")).toBe(
      "https://example.com/path?token=[REDACTED]",
    );
  });

  it("redacts multiple sensitive params", () => {
    expect(
      sanitizeUrl(
        "https://example.com/path?token=abc&access_token=def&normal=ok",
      ),
    ).toBe(
      "https://example.com/path?token=[REDACTED]&access_token=[REDACTED]&normal=ok",
    );
  });

  it("strips credentials from URL", () => {
    expect(sanitizeUrl("https://user:pass@example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("handles malformed URLs gracefully", () => {
    expect(sanitizeUrl("not a valid url")).toBe("[REDACTED]");
    expect(sanitizeUrl("")).toBe("[REDACTED]");
  });

  it("handles URL with fragment", () => {
    expect(sanitizeUrl("https://example.com/path?token=secret#section")).toBe(
      "https://example.com/path?token=[REDACTED]#section",
    );
  });

  it("preserves non-sensitive params", () => {
    expect(sanitizeUrl("https://example.com/path?foo=bar&baz=qux")).toBe(
      "https://example.com/path?foo=bar&baz=qux",
    );
  });

  it("handles case-insensitive sensitive param names", () => {
    expect(sanitizeUrl("https://example.com/path?TOKEN=secret")).toBe(
      "https://example.com/path?TOKEN=[REDACTED]",
    );
    expect(sanitizeUrl("https://example.com/path?Access_Token=secret")).toBe(
      "https://example.com/path?Access_Token=[REDACTED]",
    );
  });
});

describe("sanitizeString", () => {
  it("redacts Bearer tokens", () => {
    expect(sanitizeString("Authorization: Bearer abc123")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(sanitizeString(`Token: ${jwt}`)).toBe(`Token: [REDACTED]`);
  });

  it("redacts API key patterns", () => {
    expect(sanitizeString("api_key=sk_live_abcdefghijklmnop")).toBe(
      "api_key=[REDACTED]",
    );
    expect(sanitizeString("apikey: secret12345678901234")).toBe(
      "apikey: [REDACTED]",
    );
    expect(sanitizeString("access_token=abcdefghijklmnopqrstuvwxyz")).toBe(
      "access_token=[REDACTED]",
    );
  });

  it("redacts password patterns", () => {
    expect(sanitizeString("password=mysecretpassword")).toBe(
      "password=[REDACTED]",
    );
    expect(sanitizeString("pwd: secret123")).toBe("pwd: [REDACTED]");
  });

  it("redacts credit card-like sequences", () => {
    expect(sanitizeString("Card: 4111 1111 1111 1111")).toBe(
      "Card: [REDACTED]",
    );
    expect(sanitizeString("4111-1111-1111-1111")).toBe("[REDACTED]");
    expect(sanitizeString("4111111111111111")).toBe("[REDACTED]");
  });

  it("does not redact short numbers", () => {
    expect(sanitizeString("Order 12345")).toBe("Order 12345");
    expect(sanitizeString("Phone 555-1234")).toBe("Phone 555-1234");
  });

  it("redacts cookie-like patterns", () => {
    expect(sanitizeString("sessionid=abcdefghijklmnopqrstuvwxyz")).toBe(
      "sessionid=[REDACTED]",
    );
    expect(sanitizeString("sid: secret12345678901234")).toBe("sid: [REDACTED]");
  });

  it("redacts Authorization header values", () => {
    expect(sanitizeString("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  it("handles empty/undefined input", () => {
    expect(sanitizeString("")).toBe("");
    // Note: TypeScript would catch null/undefined at compile time
  });
});

describe("sanitizeContext", () => {
  it("redacts sensitive keys entirely", () => {
    const input = { password: "secret", normal: "value" };
    expect(sanitizeContext(input)).toEqual({
      password: "[REDACTED]",
      normal: "value",
    });
  });

  it("sanitizes string values recursively", () => {
    const input = {
      user: { token: "abc123", name: "John" },
      message: "Bearer xyz789",
    };
    expect(sanitizeContext(input)).toEqual({
      user: { token: "[REDACTED]", name: "John" },
      message: "Bearer [REDACTED]",
    });
  });

  it("handles arrays", () => {
    const input = { tags: ["Bearer token1", "normal"] };
    expect(sanitizeContext(input)).toEqual({
      tags: ["Bearer [REDACTED]", "normal"],
    });
  });

  it("respects max depth limit", () => {
    const deep: Record<string, unknown> = { a: 1 };
    let current = deep;
    for (let i = 0; i < TELEMETRY_LIMITS.MAX_CONTEXT_DEPTH + 2; i++) {
      current.nested = { value: i };
      current = current.nested as Record<string, unknown>;
    }
    const result = sanitizeContext(deep);
    expect(result).toHaveProperty("[truncated]");
  });

  it("handles null/undefined values", () => {
    const input = { a: null, b: undefined, c: "test" };
    expect(sanitizeContext(input)).toEqual({ a: null, c: "test" });
  });
});

describe("redactSecrets", () => {
  it("combines URL and string sanitization", () => {
    const input =
      "POST https://api.example.com?token=secret Authorization: Bearer jwt.token.here";
    const result = redactSecrets(input);
    expect(result).toContain("token=[REDACTED]");
    expect(result).toContain("Bearer [REDACTED]");
  });
});

describe("isSensitiveInput", () => {
  function createInput(attrs: Record<string, string>): HTMLInputElement {
    const input = document.createElement("input");
    for (const [key, value] of Object.entries(attrs)) {
      input.setAttribute(key, value);
    }
    return input;
  }

  it("blocks password type", () => {
    expect(isSensitiveInput(createInput({ type: "password" }))).toBe(true);
  });

  it("blocks current-password autocomplete", () => {
    expect(
      isSensitiveInput(
        createInput({ type: "text", autocomplete: "current-password" }),
      ),
    ).toBe(true);
  });

  it("blocks new-password autocomplete", () => {
    expect(
      isSensitiveInput(
        createInput({ type: "text", autocomplete: "new-password" }),
      ),
    ).toBe(true);
  });

  it("blocks credit card autocomplete", () => {
    expect(
      isSensitiveInput(
        createInput({ type: "text", autocomplete: "cc-number" }),
      ),
    ).toBe(true);
    expect(
      isSensitiveInput(
        createInput({ type: "text", autocomplete: "credit-card" }),
      ),
    ).toBe(true);
  });

  it("blocks data-replaybug-mask on element", () => {
    expect(
      isSensitiveInput(
        createInput({ type: "text", "data-replaybug-mask": "true" }),
      ),
    ).toBe(true);
  });

  it("blocks data-replaybug-mask on ancestor", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-replaybug-mask", "true");
    const input = createInput({ type: "text" });
    wrapper.appendChild(input);
    expect(isSensitiveInput(input)).toBe(true);
  });

  it("blocks sensitive name/id patterns", () => {
    expect(
      isSensitiveInput(createInput({ name: "api_token", type: "text" })),
    ).toBe(true);
    expect(
      isSensitiveInput(createInput({ id: "secret_key", type: "text" })),
    ).toBe(true);
    expect(
      isSensitiveInput(createInput({ name: "card_number", type: "text" })),
    ).toBe(true);
  });

  it("allows normal text inputs", () => {
    expect(
      isSensitiveInput(createInput({ type: "text", name: "username" })),
    ).toBe(false);
    expect(
      isSensitiveInput(createInput({ type: "email", name: "email" })),
    ).toBe(false);
    expect(
      isSensitiveInput(createInput({ type: "text", name: "search" })),
    ).toBe(false);
  });

  it("allows safe input with explicit safe selector (checked elsewhere)", () => {
    // This function only checks sensitivity; safe selector allowlist is handled by caller
    expect(
      isSensitiveInput(createInput({ type: "text", name: "safe_field" })),
    ).toBe(false);
  });
});

describe("sanitizeLocatorText", () => {
  it("truncates long text", () => {
    const long = "a".repeat(200);
    const result = sanitizeLocatorText(long, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith("...")).toBe(true);
  });

  it("redacts sensitive content in locator", () => {
    expect(sanitizeLocatorText("Password: secret123")).toBe(
      "Password: [REDACTED]",
    );
  });

  it("handles empty input", () => {
    expect(sanitizeLocatorText("")).toBe("");
  });
});

describe("truncateToBytes", () => {
  it("returns original if under limit", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
  });

  it("truncates at byte boundary", () => {
    const result = truncateToBytes("hello world", 5);
    expect(result).toBe("hello…");
  });

  it("handles multi-byte characters", () => {
    const emoji = "🎉🎉🎉"; // Each is 4 bytes in UTF-8
    const result = truncateToBytes(emoji, 4);
    expect(result).toBe("🎉…");
  });
});

describe("sanitizeEventPayload", () => {
  it("truncates message field", () => {
    const longMsg = "x".repeat(TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH + 100);
    const result = sanitizeEventPayload({ message: longMsg });
    expect((result.message as string).length).toBeLessThanOrEqual(
      TELEMETRY_LIMITS.MAX_MESSAGE_LENGTH + 1, // +1 for ellipsis
    );
  });

  it("truncates stack frames", () => {
    const frames = Array.from({ length: 150 }, (_, i) => ({
      filename: `file${i}.js`,
      function: `func${i}`,
    }));
    const result = sanitizeEventPayload({
      payload: { values: [{ stacktrace: { frames } }] },
    });
    const framesResult = (
      result.payload as { values: Array<{ stacktrace: { frames: unknown[] } }> }
    ).values[0]!.stacktrace.frames;
    expect(framesResult.length).toBe(TELEMETRY_LIMITS.MAX_STACK_FRAMES);
  });
});

describe("isSensitiveParam", () => {
  it("matches all defined sensitive params", () => {
    for (const param of SENSITIVE_URL_PARAMS) {
      expect(isSensitiveParam(param)).toBe(true);
      expect(isSensitiveParam(param.toUpperCase())).toBe(true);
    }
  });

  it("does not match non-sensitive params", () => {
    expect(isSensitiveParam("foo")).toBe(false);
    expect(isSensitiveParam("bar")).toBe(false);
    expect(isSensitiveParam("normal")).toBe(false);
  });
});

describe("isSensitiveKey", () => {
  it("matches known sensitive keys", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("access_token")).toBe(true);
    expect(isSensitiveKey("credit_card")).toBe(true);
  });

  it("matches keys ending with sensitive suffix", () => {
    expect(isSensitiveKey("user_password")).toBe(true);
    expect(isSensitiveKey("oauth_token")).toBe(true);
  });

  it("does not match non-sensitive keys", () => {
    expect(isSensitiveKey("username")).toBe(false);
    expect(isSensitiveKey("email")).toBe(false);
    expect(isSensitiveKey("name")).toBe(false);
  });
});
