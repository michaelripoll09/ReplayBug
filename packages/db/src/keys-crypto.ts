import {
  createHash,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";

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

/**
 * Secret project token format: `rb_sk_<prefix>_<secret>`.
 *
 * - `prefix` is 8 lowercase hex chars (4 CSPRNG bytes). It is stored in
 *   plaintext for prefix lookup/display and is NOT secret.
 * - `secret` is 43 base64url chars (32 CSPRNG bytes, 256-bit entropy).
 * - The full token is returned ONE time at creation and never persisted.
 *   Only `prefix` + `sha256(fullToken)` are stored.
 * - Project-scoped identity only: no JWT, no encoded permissions. Every
 *   privileged use re-checks project scope against `project_keys`.
 *
 * Hashing reuses the canonical public-key strategy (SHA-256 over the full
 * credential + timingSafeEqual comparison): the secret carries 256-bit
 * entropy, so a fast hash is sufficient and side-channel-safe.
 */
export const SECRET_KEY_PREFIX = "rb_sk_";
const SECRET_FULL_TOKEN_RE = /^rb_sk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export interface ParsedSecretToken {
  prefix: string;
  secret: string;
  fullToken: string;
}

export class SecretTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretTokenError";
  }
}

/** Generate a new secret project token (CSPRNG). Returns full token + prefix. */
export function generateSecretToken(): {
  fullToken: string;
  prefix: string;
} {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const fullToken = `${SECRET_KEY_PREFIX}${prefix}_${secret}`;
  return { fullToken, prefix };
}

/** Parse `rb_sk_<prefix>_<secret>`. Throws SecretTokenError on mismatch. */
export function parseSecretToken(input: unknown): ParsedSecretToken {
  if (typeof input !== "string") {
    throw new SecretTokenError("Token must be a string");
  }
  const match = SECRET_FULL_TOKEN_RE.exec(input.trim());
  if (match === null) {
    throw new SecretTokenError("Invalid secret token format");
  }
  const prefix = match[1];
  const secret = match[2];
  if (prefix === undefined || secret === undefined) {
    throw new SecretTokenError("Invalid secret token format");
  }
  return { prefix, secret, fullToken: input.trim() };
}

/** sha256 hex of the full token. Stored at rest; never store plaintext. */
export function hashSecretToken(fullToken: string): string {
  const parsed = parseSecretToken(fullToken);
  return createHash("sha256").update(parsed.fullToken, "utf8").digest("hex");
}

/**
 * Timing-safe verification of a candidate full token against a stored hash.
 * Returns false for malformed candidates instead of throwing (auth-safe).
 * Public ingest keys (`rb_pk_…`) never verify: the prefix format check
 * rejects them before any comparison runs.
 */
export function verifySecretToken(
  candidate: string,
  storedHash: string,
): boolean {
  let candidateHash: string;
  try {
    candidateHash = hashSecretToken(candidate);
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

/**
 * Derive anonymous user hash using HMAC-SHA256.
 *
 * This ensures:
 * - Same project + same raw user ID → same hash (deterministic)
 * - Different project + same raw user ID → different hash (project isolation)
 * - Different raw user ID → different hash (user isolation)
 * - Raw user ID never persists in database or logs
 *
 * The secret must be a server-side configured secret (min 32 bytes, from env).
 * Production must fail-fast if secret is missing or too short.
 */
export interface DeriveAnonymousUserHashInput {
  projectId: string;
  rawUserId: string;
  secret: string;
}

export function deriveAnonymousUserHash(
  input: DeriveAnonymousUserHashInput,
): string {
  const { projectId, rawUserId, secret } = input;

  if (!secret || secret.length < 32) {
    throw new Error(
      "Anonymous user hash secret must be configured and at least 32 characters",
    );
  }
  if (!projectId || !rawUserId) {
    throw new Error("projectId and rawUserId are required");
  }

  // HMAC-SHA256 with projectId as salt for domain separation
  // Format: HMAC-SHA256(secret, projectId + ":" + rawUserId)
  const data = `${projectId}:${rawUserId}`;
  const hmac = createHmac("sha256", secret);
  hmac.update(data);
  return hmac.digest("hex");
}
