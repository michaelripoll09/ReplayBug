import { describe, expect, it } from "vitest";
import { cn } from "./cn.js";

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("resolves conflicting Tailwind utilities with the last one winning", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("supports conditional inputs", () => {
    const isHidden = false;
    expect(cn("base", isHidden && "hidden", undefined, "extra")).toBe(
      "base extra",
    );
  });
});
