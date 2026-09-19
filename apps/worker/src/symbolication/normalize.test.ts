import { describe, expect, it } from "vitest";
import { normalizeGeneratedUrl } from "./normalize.js";

/**
 * RS-08 generated-URL normalization (TDD).
 *
 * Browser filenames become generated artifact paths: strip origin, query
 * and hash; preserve Vite hashed assets verbatim (`assets/index-C8bf2.js`).
 * Pure string ops only — never fetched, never executed.
 */
describe("normalizeGeneratedUrl", () => {
  it("strips https origin, query and hash to a POSIX relative path", () => {
    expect(
      normalizeGeneratedUrl(
        "https://example.com/assets/index-C8bf2.js?cache=123#section",
      ),
    ).toBe("assets/index-C8bf2.js");
  });

  it("strips http origin and query without a hash", () => {
    expect(
      normalizeGeneratedUrl("http://localhost:5173/src/App.tsx?v=1.2.3"),
    ).toBe("src/App.tsx");
  });

  it("handles protocol-relative URLs by stripping the host", () => {
    expect(normalizeGeneratedUrl("//cdn.example.com/assets/app.js")).toBe(
      "assets/app.js",
    );
  });

  it("strips a leading slash from absolute paths", () => {
    expect(normalizeGeneratedUrl("/assets/index-C8bf2.js")).toBe(
      "assets/index-C8bf2.js",
    );
  });

  it("preserves Vite hashed assets verbatim", () => {
    expect(normalizeGeneratedUrl("assets/index-C8bf2.js")).toBe(
      "assets/index-C8bf2.js",
    );
    expect(
      normalizeGeneratedUrl("https://example.com/assets/index-C8bf2.js?x=1#y"),
    ).toBe("assets/index-C8bf2.js");
  });

  it("preserves nested Vite output paths", () => {
    expect(
      normalizeGeneratedUrl(
        "https://cdn.example.com/static/js/main.a1b2c3d4.js?ver=9",
      ),
    ).toBe("static/js/main.a1b2c3d4.js");
  });

  it("handles plain relative paths", () => {
    expect(normalizeGeneratedUrl("assets/app.js")).toBe("assets/app.js");
    expect(normalizeGeneratedUrl("app.js")).toBe("app.js");
  });

  it("returns null for empty, blank and hash-only inputs", () => {
    expect(normalizeGeneratedUrl("")).toBeNull();
    expect(normalizeGeneratedUrl("   ")).toBeNull();
    expect(normalizeGeneratedUrl("#section")).toBeNull();
    expect(normalizeGeneratedUrl("?x=1")).toBeNull();
  });

  it("returns null for data: and blob: URLs (no artifact path)", () => {
    expect(
      normalizeGeneratedUrl("data:text/javascript;base64,abcd"),
    ).toBeNull();
    expect(normalizeGeneratedUrl("blob:https://example.com/uuid")).toBeNull();
  });

  it("returns null for traversal and backslash escapes", () => {
    expect(
      normalizeGeneratedUrl("https://example.com/../secret.js"),
    ).toBeNull();
    expect(normalizeGeneratedUrl("assets/../../secret.js")).toBeNull();
    expect(normalizeGeneratedUrl("assets\\app.js")).toBeNull();
  });

  it("returns null for dot segments and empty segments", () => {
    expect(normalizeGeneratedUrl("assets/./app.js")).toBeNull();
    expect(normalizeGeneratedUrl("assets//app.js")).toBeNull();
  });

  it("strips query and hash from relative paths", () => {
    expect(normalizeGeneratedUrl("assets/app.js?hash=abc")).toBe(
      "assets/app.js",
    );
    expect(normalizeGeneratedUrl("assets/app.js#source")).toBe("assets/app.js");
  });

  it("does not normalize content hashes away (lookup needs exact path)", () => {
    // Fingerprinting normalizes hashes; symbolication must NOT — the exact
    // uploaded path is required for the artifact lookup.
    expect(normalizeGeneratedUrl("assets/index-Bx3K9mPQ.js")).toBe(
      "assets/index-Bx3K9mPQ.js",
    );
  });
});
