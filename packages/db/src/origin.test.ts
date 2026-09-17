import { describe, expect, it } from "vitest";
import {
  OriginParseError,
  isLocalhostOrigin,
  parseBaseUrl,
  parseOrigin,
} from "./origin.js";

describe("parseOrigin", () => {
  it("accepts a bare https origin", () => {
    expect(parseOrigin("https://example.com")).toBe("https://example.com");
  });

  it("normalizes trailing slashes", () => {
    expect(parseOrigin("https://example.com/")).toBe("https://example.com");
    expect(parseOrigin("https://example.com///")).toBe("https://example.com");
    expect(parseOrigin("  https://example.com/  ")).toBe("https://example.com");
  });

  it("lowercases scheme and host but preserves explicit ports", () => {
    expect(parseOrigin("HTTPS://Example.COM:8443/")).toBe(
      "https://example.com:8443",
    );
  });

  it("accepts explicit localhost dev origins", () => {
    expect(parseOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(parseOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(parseOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("rejects paths", () => {
    expect(() => parseOrigin("https://example.com/app")).toThrow(
      OriginParseError,
    );
    expect(() => parseOrigin("https://example.com/app/callback?x=1")).toThrow(
      OriginParseError,
    );
  });

  it("rejects query and fragment", () => {
    expect(() => parseOrigin("https://example.com?x=1")).toThrow(
      OriginParseError,
    );
    expect(() => parseOrigin("https://example.com#frag")).toThrow(
      OriginParseError,
    );
  });

  it("rejects non-http schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "ftp://example.com",
      "ws://example.com",
    ]) {
      expect(() => parseOrigin(bad)).toThrow(OriginParseError);
    }
  });

  it("rejects wildcards including literal localhost star", () => {
    expect(() => parseOrigin("http://localhost:*")).toThrow(OriginParseError);
    expect(() => parseOrigin("https://*.example.com")).toThrow(
      OriginParseError,
    );
    expect(() => parseOrigin("https://exam*.com")).toThrow(OriginParseError);
  });

  it("rejects credentials in origin", () => {
    expect(() => parseOrigin("https://user:pass@example.com")).toThrow(
      OriginParseError,
    );
  });

  it("rejects empty, whitespace and non-strings", () => {
    expect(() => parseOrigin("")).toThrow(OriginParseError);
    expect(() => parseOrigin("   ")).toThrow(OriginParseError);
    expect(() => parseOrigin(42)).toThrow(OriginParseError);
    expect(() => parseOrigin(undefined)).toThrow(OriginParseError);
  });

  it("rejects whitespace inside and invalid URLs", () => {
    expect(() => parseOrigin("https://exa mple.com")).toThrow(OriginParseError);
    expect(() => parseOrigin("not-a-url")).toThrow(OriginParseError);
    expect(() => parseOrigin("example.com")).toThrow(OriginParseError);
  });
});

describe("isLocalhostOrigin", () => {
  it("detects localhost origins", () => {
    expect(isLocalhostOrigin("http://localhost:5173")).toBe(true);
    expect(isLocalhostOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalhostOrigin("https://example.com")).toBe(false);
  });
});

describe("parseBaseUrl", () => {
  it("accepts https with path", () => {
    expect(parseBaseUrl("https://app.example.com/subpath")).toBe(
      "https://app.example.com/subpath",
    );
  });

  it("rejects javascript/file/data schemes", () => {
    expect(() => parseBaseUrl("javascript:alert(1)")).toThrow(OriginParseError);
    expect(() => parseBaseUrl("file:///etc/passwd")).toThrow(OriginParseError);
    expect(() => parseBaseUrl("data:text/plain,hi")).toThrow(OriginParseError);
  });

  it("rejects credentials", () => {
    expect(() => parseBaseUrl("https://user:pass@example.com/x")).toThrow(
      OriginParseError,
    );
  });
});
