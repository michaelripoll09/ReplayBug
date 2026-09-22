import { describe, expect, it } from "vitest";
import {
  MINIFIED_RELEASE_BUTTON_LABEL,
  MINIFIED_RELEASE_SCENARIO_ID,
  MINIFIED_RELEASE_TEST_ID,
  MINIFIED_RELEASE_VERSION,
  triggerMinifiedReleaseError,
} from "./minified-release-error.js";

describe("minified-release-error scenario (RS-11)", () => {
  it("throws the deterministic release error after the null guard", () => {
    try {
      triggerMinifiedReleaseError();
      expect.unreachable("scenario must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(
        /^DEMO: Minified release error is unreachable/,
      );
    }
  });

  it("exposes deterministic hooks for the RS-12 production E2E", () => {
    expect(MINIFIED_RELEASE_SCENARIO_ID).toBe("minified-release-error");
    expect(MINIFIED_RELEASE_BUTTON_LABEL).toBe("6. Minified Release Error");
    expect(MINIFIED_RELEASE_TEST_ID).toBe("scenario-minified-release-error");
    expect(MINIFIED_RELEASE_VERSION).toBe("demo@1.0.0");
  });
});
