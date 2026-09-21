import { describe, expect, it } from "vitest";
import {
  MINIFIED_RELEASE_BUTTON_LABEL,
  MINIFIED_RELEASE_SCENARIO_ID,
  MINIFIED_RELEASE_TEST_ID,
  MINIFIED_RELEASE_VERSION,
  triggerMinifiedReleaseError,
} from "./minified-release-error.js";

describe("minified-release-error scenario (RS-11)", () => {
  it("throws a genuine TypeError reading `lines` of a null payload", () => {
    try {
      triggerMinifiedReleaseError();
      expect.unreachable("scenario must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(
        "Cannot read properties of null",
      );
      expect((error as Error).message).toContain("lines");
    }
  });

  it("exposes deterministic hooks for the RS-12 production E2E", () => {
    expect(MINIFIED_RELEASE_SCENARIO_ID).toBe("minified-release-error");
    expect(MINIFIED_RELEASE_BUTTON_LABEL).toBe("6. Minified Release Error");
    expect(MINIFIED_RELEASE_TEST_ID).toBe("scenario-minified-release-error");
    expect(MINIFIED_RELEASE_VERSION).toBe("demo@1.0.0");
  });
});
