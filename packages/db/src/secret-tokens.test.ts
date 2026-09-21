import { describe, expect, it } from "vitest";
import {
  generatePublicKey,
  generateSecretToken,
  hashSecretToken,
  parseSecretToken,
  SECRET_KEY_PREFIX,
  SecretTokenError,
  verifySecretToken,
} from "./keys-crypto.js";

/**
 * RS-02 secret-token crypto: project-scoped `rb_sk_<8hex>_<43b64url>`
 * credentials from 256-bit CSPRNG, SHA-256 at rest, timing-safe verify.
 * No JWT, no encoded permissions — identity only.
 */
describe("secret project tokens", () => {
  it("generates rb_sk_<prefix>_<secret> tokens with 256-bit secrets", () => {
    const { fullToken, prefix } = generateSecretToken();
    expect(SECRET_KEY_PREFIX).toBe("rb_sk_");
    expect(fullToken.startsWith("rb_sk_")).toBe(true);
    expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(fullToken).toMatch(/^rb_sk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseSecretToken(fullToken);
    expect(parsed.prefix).toBe(prefix);
    expect(parsed.fullToken).toBe(fullToken);
  });

  it("generates unique tokens", () => {
    const a = generateSecretToken().fullToken;
    const b = generateSecretToken().fullToken;
    expect(a).not.toBe(b);
  });

  it("parses valid tokens and rejects malformed input", () => {
    const { fullToken, prefix } = generateSecretToken();
    const parsed = parseSecretToken(fullToken);
    expect(parsed.prefix).toBe(prefix);
    expect(() => parseSecretToken("not-a-token")).toThrow(SecretTokenError);
    expect(() => parseSecretToken("rb_sk_short_x")).toThrow(SecretTokenError);
    expect(() => parseSecretToken(42)).toThrow(SecretTokenError);
    expect(() => parseSecretToken("")).toThrow(SecretTokenError);
    // Public ingest keys are a different credential and must not parse.
    expect(() => parseSecretToken(generatePublicKey().fullKey)).toThrow(
      SecretTokenError,
    );
  });

  it("hashes deterministically and never returns plaintext", () => {
    const { fullToken } = generateSecretToken();
    const h1 = hashSecretToken(fullToken);
    const h2 = hashSecretToken(fullToken);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(fullToken);
  });

  it("verifies the active token and rejects a wrong secret with the same prefix", () => {
    const { fullToken, prefix } = generateSecretToken();
    const hash = hashSecretToken(fullToken);
    expect(verifySecretToken(fullToken, hash)).toBe(true);
    // Same prefix, different secret: must fail.
    const other = generateSecretToken();
    const samePrefixDifferentSecret = `rb_sk_${prefix}_${other.fullToken.split("_")[2] ?? ""}`;
    expect(samePrefixDifferentSecret).not.toBe(fullToken);
    expect(verifySecretToken(samePrefixDifferentSecret, hash)).toBe(false);
    expect(verifySecretToken(generateSecretToken().fullToken, hash)).toBe(
      false,
    );
  });

  it("fails closed on malformed candidates and corrupt hashes", () => {
    const { fullToken } = generateSecretToken();
    const hash = hashSecretToken(fullToken);
    expect(verifySecretToken("garbage", hash)).toBe(false);
    expect(verifySecretToken("", hash)).toBe(false);
    expect(verifySecretToken(fullToken, "not-hex")).toBe(false);
    expect(verifySecretToken(fullToken, "")).toBe(false);
    // A public ingest key can never pass secret verification.
    expect(
      verifySecretToken(
        generatePublicKey().fullKey,
        hashSecretToken(fullToken),
      ),
    ).toBe(false);
  });
});
