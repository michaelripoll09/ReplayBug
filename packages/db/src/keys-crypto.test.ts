import { describe, expect, it } from "vitest";
import {
  generatePublicKey,
  hashPublicKey,
  parsePublicKey,
  PublicKeyError,
  verifyPublicKey,
  deriveAnonymousUserHash,
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

describe("deriveAnonymousUserHash", () => {
  const secret = "test-hmac-secret-0123456789abcdef0123456789ab"; // 32+ chars
  const projectId = "123e4567-e89b-12d3-a456-426614174000";
  const rawUserId = "synthetic-user-123";

  it("same project + same raw ID -> same hash (deterministic)", () => {
    const hash1 = deriveAnonymousUserHash({ projectId, rawUserId, secret });
    const hash2 = deriveAnonymousUserHash({ projectId, rawUserId, secret });
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("same project + different raw ID -> different hash", () => {
    const hash1 = deriveAnonymousUserHash({ projectId, rawUserId, secret });
    const hash2 = deriveAnonymousUserHash({
      projectId,
      rawUserId: "different-user-456",
      secret,
    });
    expect(hash1).not.toBe(hash2);
  });

  it("different project + same raw ID -> different hash (project isolation)", () => {
    const hash1 = deriveAnonymousUserHash({ projectId, rawUserId, secret });
    const hash2 = deriveAnonymousUserHash({
      projectId: "123e4567-e89b-12d3-a456-426614174001",
      rawUserId,
      secret,
    });
    expect(hash1).not.toBe(hash2);
  });

  it("short/missing secret -> deterministic failure", () => {
    expect(() =>
      deriveAnonymousUserHash({ projectId, rawUserId, secret: "short" }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      deriveAnonymousUserHash({ projectId, rawUserId, secret: "" }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      deriveAnonymousUserHash({
        projectId,
        rawUserId,
        // @ts-expect-error testing invalid secret
        secret: undefined,
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("missing projectId or rawUserId -> deterministic failure", () => {
    expect(() =>
      deriveAnonymousUserHash({ projectId: "", rawUserId, secret }),
    ).toThrow(/required/);
    expect(() =>
      deriveAnonymousUserHash({ projectId, rawUserId: "", secret }),
    ).toThrow(/required/);
  });

  it("produces SHA-256 hex output (64 chars)", () => {
    const hash = deriveAnonymousUserHash({ projectId, rawUserId, secret });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
