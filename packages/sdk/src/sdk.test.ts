import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_PROTOCOL_VERSION, SDK_VERSION, init } from "./index.js";

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
