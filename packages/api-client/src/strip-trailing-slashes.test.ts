import { describe, expect, it } from "vitest";
import {
  createApiClient,
  createReplayBugApiClient,
  stripTrailingSlashes,
} from "./index.js";

describe("stripTrailingSlashes", () => {
  it("removes trailing slashes deterministically", () => {
    expect(stripTrailingSlashes("https://api.example.com/")).toBe(
      "https://api.example.com",
    );
    expect(stripTrailingSlashes("https://api.example.com///")).toBe(
      "https://api.example.com",
    );
    expect(stripTrailingSlashes("https://api.example.com")).toBe(
      "https://api.example.com",
    );
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("http://localhost:4001///")).toBe(
      "http://localhost:4001",
    );
  });

  it("keeps interior slashes untouched", () => {
    expect(stripTrailingSlashes("https://a.test/x//y/")).toBe(
      "https://a.test/x//y",
    );
  });

  it("completes a very long hostile input quickly", () => {
    const hostile = `https://api.example.com/${"/".repeat(150_000)}`;
    const started = Date.now();
    expect(stripTrailingSlashes(hostile)).toBe("https://api.example.com");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});

describe("baseUrl normalization parity", () => {
  it("agrees across both client constructors", () => {
    const cases: Array<[string, string]> = [
      ["https://api.example.com/", "https://api.example.com"],
      ["https://api.example.com///", "https://api.example.com"],
      ["https://api.example.com", "https://api.example.com"],
    ];
    for (const [input, expected] of cases) {
      expect(createApiClient({ baseUrl: input }).baseUrl).toBe(expected);
      expect(createReplayBugApiClient({ baseUrl: input }).baseUrl).toBe(
        expected,
      );
    }
  });

  it("still rejects normalized-empty base URLs exactly as before", () => {
    expect(() => createApiClient({ baseUrl: "/" })).toThrow(/baseUrl/);
    expect(() => createApiClient({ baseUrl: "///" })).toThrow(/baseUrl/);
    expect(() => createReplayBugApiClient({ baseUrl: "/" })).toThrow(/baseUrl/);
    expect(() => createReplayBugApiClient({ baseUrl: "///" })).toThrow(
      /baseUrl/,
    );
  });
});
