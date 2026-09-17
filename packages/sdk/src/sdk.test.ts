import { describe, expect, it } from "vitest";
import { SDK_NAME, SDK_PROTOCOL_VERSION, SDK_VERSION } from "./index.js";

describe("@replaybug/sdk foundation metadata", () => {
  it("exposes a semver SDK version", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes the package name and protocol version", () => {
    expect(SDK_NAME).toBe("@replaybug/sdk");
    expect(SDK_PROTOCOL_VERSION).toBe(1);
  });

  it("does not export a fake init() that pretends to capture", async () => {
    const moduleExports = await import("./index.js");
    expect("init" in moduleExports).toBe(false);
  });
});
