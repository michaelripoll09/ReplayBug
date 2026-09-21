import { describe, expect, it } from "vitest";
import {
  isRemoteSourceMappingUrl,
  parseTrailingSourceMappingURL,
  resolveRelativeMapReference,
} from "./source-mapping-url.js";

/**
 * RS-08 sourceMappingURL handling + SSRF matrix (TDD).
 *
 * Remote references are NEVER fetched (no network, no SSRF). Only relative
 * local same-release references resolve; every other form returns null.
 * Unit-test each scheme individually.
 */
describe("isRemoteSourceMappingUrl", () => {
  it.each([
    ["http", "http://example.com/app.js.map"],
    ["https", "https://example.com/app.js.map"],
    ["file", "file:///etc/passwd"],
    ["file with host", "file://server/share/app.js.map"],
    ["ftp", "ftp://example.com/app.js.map"],
    ["data", "data:application/json;base64,eyJ2ZXJzaW9uIjozfQ=="],
    ["protocol-relative", "//cdn.example.com/app.js.map"],
    ["uppercase scheme", "HTTP://example.com/app.js.map"],
    ["custom scheme", "custom-scheme+test.1://host/path.map"],
  ])("treats %s as remote (never fetched)", (_label, value) => {
    expect(isRemoteSourceMappingUrl(value)).toBe(true);
  });

  it.each([
    ["bare relative", "app.js.map"],
    ["nested relative", "maps/chunk.js.map"],
    ["dot-relative", "./app.js.map"],
    ["parent-relative", "../maps/app.js.map"],
    ["sibling with query", "app.js.map?x=1"],
  ])("treats %s as local", (_label, value) => {
    expect(isRemoteSourceMappingUrl(value)).toBe(false);
  });

  it("treats empty and blank values as non-remote (callers reject them)", () => {
    expect(isRemoteSourceMappingUrl("")).toBe(false);
    expect(isRemoteSourceMappingUrl("   ")).toBe(false);
  });
});

describe("parseTrailingSourceMappingURL", () => {
  it("returns the trailing reference from a minified asset tail", () => {
    const asset = `console.log(1);\n//# sourceMappingURL=app.js.map\n`;
    expect(parseTrailingSourceMappingURL(asset)).toBe("app.js.map");
  });

  it("returns the LAST reference when several are present", () => {
    const asset = [
      "//# sourceMappingURL=first.js.map",
      "console.log(1);",
      "//# sourceMappingURL=second.js.map",
    ].join("\n");
    expect(parseTrailingSourceMappingURL(asset)).toBe("second.js.map");
  });

  it("tolerates whitespace around the equals sign", () => {
    expect(
      parseTrailingSourceMappingURL("//# sourceMappingURL = app.js.map"),
    ).toBe("app.js.map");
  });

  it("returns remote references verbatim (callers must ignore them, never fetch)", () => {
    expect(
      parseTrailingSourceMappingURL(
        "var a=1;\n//# sourceMappingURL=https://cdn.example/cdn.js.map\n",
      ),
    ).toBe("https://cdn.example/cdn.js.map");
    expect(
      parseTrailingSourceMappingURL("var a=1;\n//# sourceMappingURL=data:abc"),
    ).toBe("data:abc");
    expect(
      parseTrailingSourceMappingURL(
        "var a=1;\n//# sourceMappingURL=file:///etc/passwd",
      ),
    ).toBe("file:///etc/passwd");
    expect(
      parseTrailingSourceMappingURL(
        "var a=1;\n//# sourceMappingURL=ftp://h/x.map",
      ),
    ).toBe("ftp://h/x.map");
  });

  it("returns null when no reference is present", () => {
    expect(parseTrailingSourceMappingURL("console.log(1);\n")).toBeNull();
    expect(parseTrailingSourceMappingURL("")).toBeNull();
  });
});

describe("resolveRelativeMapReference", () => {
  it("resolves a sibling reference against the asset directory", () => {
    expect(
      resolveRelativeMapReference(
        "assets/index-C8bf2.js",
        "index-C8bf2.js.map",
      ),
    ).toBe("assets/index-C8bf2.js.map");
  });

  it("resolves a nested relative reference", () => {
    expect(
      resolveRelativeMapReference("static/chunk.js", "maps/chunk.js.map"),
    ).toBe("static/maps/chunk.js.map");
  });

  it("strips query and hash before resolving", () => {
    expect(
      resolveRelativeMapReference("assets/app.js", "app.js.map?x=1#y"),
    ).toBe("assets/app.js.map");
  });

  it.each([
    ["http", "https://cdn.example/cdn.js.map"],
    ["https", "https://example.com/x.map"],
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/x.map"],
    ["data", "data:application/json,{}"],
    ["protocol-relative", "//cdn.example.com/x.map"],
  ])("returns null for remote %s (never fetched)", (_label, value) => {
    expect(resolveRelativeMapReference("assets/app.js", value)).toBeNull();
  });

  it("returns null for absolute and above-root references", () => {
    expect(
      resolveRelativeMapReference("assets/app.js", "/absolute/x.map"),
    ).toBeNull();
    // `..` above the release root has no in-release meaning: reject.
    expect(resolveRelativeMapReference("app.js", "../escape.map")).toBeNull();
    expect(resolveRelativeMapReference("assets/app.js", "")).toBeNull();
    expect(resolveRelativeMapReference("assets/app.js", "   ")).toBeNull();
  });

  it("returns null for backslash escapes but tolerates benign dot prefixes", () => {
    expect(
      resolveRelativeMapReference("assets/app.js", "..\\escape.map"),
    ).toBeNull();
    // `./` collapses to the sibling: harmless, mirrors the CLI scanner.
    expect(resolveRelativeMapReference("assets/app.js", "./app.js.map")).toBe(
      "assets/app.js.map",
    );
  });
});
