import { describe, expect, it } from "vitest";
import {
  safeCommentFragment,
  stripControlChars,
  tsSingleQuoteLiteral,
} from "./escaping.js";

describe("tsSingleQuoteLiteral", () => {
  it("escapes backslash, quote and newlines", () => {
    expect(tsSingleQuoteLiteral("a'b\\c")).toBe("'a\\'b\\\\c'");
    expect(tsSingleQuoteLiteral("x\ny")).toBe("'x\\ny'");
    expect(tsSingleQuoteLiteral("x\ry")).toBe("'x\\ry'");
  });

  it("never lets U+2028/U+2029 escape into generated output", () => {
    expect(tsSingleQuoteLiteral("a\u2028b")).toBe("'ab'");
    expect(tsSingleQuoteLiteral("a\u2029b")).toBe("'ab'");
    const out = tsSingleQuoteLiteral("\u2028\u2029");
    expect(out.includes("\u2028")).toBe(false);
    expect(out.includes("\u2029")).toBe(false);
  });

  it("stays a valid single-line literal", () => {
    const out = tsSingleQuoteLiteral("it's ${evil} `tick` \\ \n end");
    // Single quotes make `${}` and backticks inert; only the wrapping
    // quotes plus escaping remain, with no raw newline.
    expect(out).toBe("'it\\'s ${evil} `tick` \\\\ \\n end'");
    expect(out.includes("\n")).toBe(false);
  });
});

describe("stripControlChars", () => {
  it("removes U+2028 and U+2029", () => {
    expect(stripControlChars("a\u2028b\u2029c")).toBe("abc");
  });
});

describe("safeCommentFragment", () => {
  it("neutralizes comment terminators without regex filtering", () => {
    expect(safeCommentFragment("a<!--b")).toBe("a< !--b");
    expect(safeCommentFragment("a-->b")).toBe("a-- >b");
    expect(safeCommentFragment("<!-- -->")).toBe("< !-- -- >");
    expect(safeCommentFragment("a*/b")).toBe("a* /b");
  });

  it("replaces every occurrence, including embedded markers", () => {
    expect(safeCommentFragment("<!--x<!--y-->z-->")).toBe(
      "< !--x< !--y-- >z-- >",
    );
  });

  it("collapses newlines and control chars into one line", () => {
    expect(safeCommentFragment("a\nb\rc\r\nd\x01e")).toBe("a b c de");
    expect(safeCommentFragment("a\u2028b")).toBe("ab");
  });

  it("bounds output length", () => {
    const out = safeCommentFragment("x".repeat(500), 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
