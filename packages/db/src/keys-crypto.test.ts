import { describe, expect, it } from "vitest";
import {
  generatePublicKey,
  hashPublicKey,
  parsePublicKey,
  PublicKeyError,
  verifyPublicKey,
} from "./keys-crypto.js";

describe("public ingest keys", () => {
  it("generates identifiable rb_pk_<prefix>_<secret> keys", () => {
    const { fullKey, prefix } = generatePublicKey();
    expect(fullKey.startsWith("rb_pk_")).toBe(true);
    expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(fullKey).toContain(`_${prefix}_`.replace("__", "_"));
    const parsed = parsePublicKey(fullKey);
    expect(parsed.prefix).toBe(prefix);
  });

  it("generates unique keys", () => {
    const a = generatePublicKey().fullKey;
    const b = generatePublicKey().fullKey;
    expect(a).not.toBe(b);
  });

  it("parses valid keys and rejects malformed input", () => {
    const { fullKey, prefix } = generatePublicKey();
    const parsed = parsePublicKey(fullKey);
    expect(parsed.prefix).toBe(prefix);
    expect(parsed.fullKey).toBe(fullKey);
    expect(() => parsePublicKey("not-a-key")).toThrow(PublicKeyError);
    expect(() => parsePublicKey("rb_pk_short_x")).toThrow(PublicKeyError);
    expect(() => parsePublicKey(42)).toThrow(PublicKeyError);
    expect(() => parsePublicKey("")).toThrow(PublicKeyError);
  });

  it("hashes deterministically and never returns plaintext", () => {
    const { fullKey } = generatePublicKey();
    const h1 = hashPublicKey(fullKey);
    const h2 = hashPublicKey(fullKey);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(fullKey);
  });

  it("verifies with timing-safe comparison", () => {
    const { fullKey } = generatePublicKey();
    const hash = hashPublicKey(fullKey);
    expect(verifyPublicKey(fullKey, hash)).toBe(true);
    expect(verifyPublicKey(generatePublicKey().fullKey, hash)).toBe(false);
    expect(verifyPublicKey("garbage", hash)).toBe(false);
    expect(verifyPublicKey("", hash)).toBe(false);
  });
});
