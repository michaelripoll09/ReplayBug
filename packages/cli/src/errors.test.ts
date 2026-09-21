import { describe, expect, it } from "vitest";
import { CliError, formatCliError, isDebugMode } from "./errors.js";

describe("CLI errors", () => {
  it("formats message, requestId, and hint lines", () => {
    const formatted = formatCliError(
      new CliError("Something broke", {
        requestId: "req-123",
        hint: "Try again.",
      }),
    );
    expect(formatted).toBe(
      "Error: Something broke\nRequest ID: req-123\nHint: Try again.",
    );
  });

  it("omits empty requestId and hint lines", () => {
    expect(formatCliError(new CliError("Boom"))).toBe("Error: Boom");
  });

  it("detects debug mode without ever touching the token", () => {
    expect(isDebugMode({})).toBe(false);
    expect(isDebugMode({ REPLAYBUG_DEBUG: "1" })).toBe(true);
    expect(isDebugMode({ REPLAYBUG_DEBUG: "true" })).toBe(true);
    expect(isDebugMode({ REPLAYBUG_DEBUG: "0" })).toBe(false);
  });
});
