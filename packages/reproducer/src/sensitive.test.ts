import { describe, expect, it } from "vitest";
import { looksSensitiveValue } from "./sensitive.js";

describe("looksSensitiveValue card detection (linear scanner)", () => {
  it("flags 13, 16 and 19 digit runs", () => {
    expect(looksSensitiveValue("4111111111111")).toBe(true);
    expect(looksSensitiveValue("4111111111111111")).toBe(true);
    expect(looksSensitiveValue("4111111111111111111")).toBe(true);
  });

  it("flags runs with spaces and hyphens", () => {
    expect(looksSensitiveValue("4111 1111 1111 1111")).toBe(true);
    expect(looksSensitiveValue("4111-1111-1111-1111")).toBe(true);
    expect(looksSensitiveValue("4111-1111 1111-1111")).toBe(true);
  });

  it("flags runs embedded in surrounding text", () => {
    expect(looksSensitiveValue("card 4111111111111111 ok")).toBe(true);
    expect(looksSensitiveValue("(4111111111111111)")).toBe(true);
  });

  it("rejects too-short and too-long digit totals", () => {
    expect(looksSensitiveValue("411111111111")).toBe(false);
    expect(looksSensitiveValue("41111111111111111111")).toBe(false);
    expect(looksSensitiveValue("411111111111111111111")).toBe(false);
  });

  it("rejects runs broken by letters", () => {
    expect(looksSensitiveValue("4111111111111111x")).toBe(false);
    expect(looksSensitiveValue("x4111111111111111")).toBe(false);
  });

  it("keeps other sensitive patterns unaffected", () => {
    expect(
      looksSensitiveValue(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe(true);
    expect(looksSensitiveValue("Bearer abcdefghijklmnop")).toBe(true);
    expect(looksSensitiveValue("token=abcdefghijklmnop")).toBe(true);
    expect(looksSensitiveValue("plain hello world", "message")).toBe(false);
  });

  it("completes a very long hostile input quickly", () => {
    const hostile = `${"1 ".repeat(80_000)}!`;
    const started = Date.now();
    const out = looksSensitiveValue(hostile);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toBe(false);
  }, 15000);

  it("scans a card-like run with a long tail quickly", () => {
    const hostile = `${"1 ".repeat(17)}11${"z".repeat(150_000)}`;
    const started = Date.now();
    expect(looksSensitiveValue(hostile)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});
