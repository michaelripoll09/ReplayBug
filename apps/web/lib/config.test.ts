import { describe, expect, it, beforeEach } from "vitest";
import { getWebConfig, resetWebConfigForTests } from "./config";

describe("getWebConfig", () => {
  beforeEach(() => {
    resetWebConfigForTests();
    delete process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"];
  });

  it("defaults to the dev API URL", () => {
    expect(getWebConfig().apiUrl).toBe("http://localhost:4001");
  });

  it("strips trailing slashes", () => {
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] = "http://localhost:4001///";
    expect(getWebConfig().apiUrl).toBe("http://localhost:4001");
  });

  it("accepts same-origin relative URLs (reverse-proxy friendly)", () => {
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] = "/api";
    expect(getWebConfig().apiUrl).toBe("/api");
  });

  it("rejects non-http(s) URLs", () => {
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] = "javascript:alert(1)";
    expect(() => getWebConfig()).toThrow(/NEXT_PUBLIC_REPLAYBUG_API_URL/);
  });

  it("memoizes the validated config", () => {
    const first = getWebConfig();
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] = "http://evil.example.com";
    expect(getWebConfig()).toBe(first);
  });
});
