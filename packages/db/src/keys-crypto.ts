import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Public ingest key format: `rb_pk_<prefix>_<secret>`.
 *
 * - `prefix` is 8 lowercase hex chars (4 CSPRNG bytes). It is stored in
 *   plaintext for prefix lookup/display and is NOT secret.
 * - `secret` is 43 base64url chars (32 CSPRNG bytes, 256-bit entropy).
 * - The full key is returned ONE time at creation/rotation and never
 *   persisted. Only `prefix` + `sha256(fullKey)` are stored.
 *
 * sha256 is deliberate: the secret has 256-bit entropy so a fast hash is
 * sufficient and timing-safe comparison prevents side-channel leaks.
 * No homegrown crypto: Node's WebCrypto-compatible CSPRNG + SHA-256 only.
 */
export const PUBLIC_KEY_PREFIX = "rb_pk_";
const PREFIX_BYTES = 4;
const SECRET_BYTES = 32;
const FULL_KEY_RE = /^rb_pk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export interface ParsedPublicKey {
  prefix: string;
  secret: string;
  fullKey: string;
}

export class PublicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicKeyError";
  }
}

/** Generate a new public ingest key (CSPRNG). Returns full key + prefix. */
export function generatePublicKey(): { fullKey: string; prefix: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${PUBLIC_KEY_PREFIX}${prefix}_${secret}`;
  return { fullKey, prefix };
}

/** Parse `rb_pk_<prefix>_<secret>`. Throws PublicKeyError on mismatch. */
export function parsePublicKey(input: unknown): ParsedPublicKey {
  if (typeof input !== "string") {
    throw new PublicKeyError("Key must be a string");
  }
  const match = FULL_KEY_RE.exec(input.trim());
  if (match === null) {
    throw new PublicKeyError("Invalid public key format");
  }
  const prefix = match[1];
  const secret = match[2];
  if (prefix === undefined || secret === undefined) {
    throw new PublicKeyError("Invalid public key format");
  }
  return { prefix, secret, fullKey: input.trim() };
}

/** sha256 hex of the full key. Stored at rest; never store plaintext. */
export function hashPublicKey(fullKey: string): string {
  const parsed = parsePublicKey(fullKey);
  return createHash("sha256").update(parsed.fullKey, "utf8").digest("hex");
}

/**
 * Timing-safe verification of a candidate full key against a stored hash.
 * Returns false for malformed candidates instead of throwing (ingest-safe).
 */
export function verifyPublicKey(
  candidate: string,
  storedHash: string,
): boolean {
  let candidateHash: string;
  try {
    candidateHash = hashPublicKey(candidate);
  } catch {
    return false;
  }
  try {
    const a = Buffer.from(candidateHash, "hex");
    const b = Buffer.from(storedHash, "hex");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
