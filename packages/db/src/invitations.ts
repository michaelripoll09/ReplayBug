import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export const INVITATION_TOKEN_PREFIX = "rb_inv_";
export const INVITATION_TOKEN_PREFIX_BYTES = 4;
export const INVITATION_TOKEN_SECRET_BYTES = 32;
export const INVITATION_EXPIRY_DAYS = 7;
export const INVITATION_TTL_MS = INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const INVITATION_TOKEN_RE = new RegExp(
  `^${INVITATION_TOKEN_PREFIX}([0-9a-f]{${INVITATION_TOKEN_PREFIX_BYTES * 2}})_([A-Za-z0-9_-]{43})$`,
);
const INVITATION_TOKEN_PREFIX_RE = new RegExp(
  `^[0-9a-f]{${INVITATION_TOKEN_PREFIX_BYTES * 2}}$`,
);
const INVITATION_TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const INVITATION_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INVITATION_EMAIL_MAX_LENGTH = 320;

export const INVITATION_ROLES = ["admin", "member", "viewer"] as const;

export type InvitationRole = (typeof INVITATION_ROLES)[number];

export interface ParsedInvitationToken {
  token: string;
  tokenPrefix: string;
  secret: string;
}

export interface GeneratedInvitationToken {
  token: string;
  tokenPrefix: string;
  tokenHash: string;
  expiresAt: Date;
}

export class InvitationTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationTokenError";
  }
}

export class InvitationEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationEmailError";
  }
}

export class InvitationRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvitationRoleError";
  }
}

/**
 * Normalize an invitation address before it is compared, stored, or queried.
 * The normalization is intentionally conservative: trim and lowercase only;
 * it never rewrites provider-specific addresses or aliases.
 */
export function normalizeInvitationEmail(input: unknown): string {
  if (typeof input !== "string") {
    throw new InvitationEmailError("Invitation email must be a string");
  }
  const normalized = input.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > INVITATION_EMAIL_MAX_LENGTH ||
    !INVITATION_EMAIL_RE.test(normalized)
  ) {
    throw new InvitationEmailError("Invitation email has an invalid format");
  }
  return normalized;
}

/** Validate the role that may be granted by an invitation; owner is excluded. */
export function validateInvitationRole(input: unknown): InvitationRole {
  if (input !== "admin" && input !== "member" && input !== "viewer") {
    throw new InvitationRoleError(
      "Invitation role must be admin, member, or viewer",
    );
  }
  return input;
}

/** Parse the opaque invitation token without exposing it in an error message. */
export function parseInvitationToken(input: unknown): ParsedInvitationToken {
  if (typeof input !== "string") {
    throw new InvitationTokenError("Invitation token must be a string");
  }
  const token = input.trim();
  const match = INVITATION_TOKEN_RE.exec(token);
  if (match === null) {
    throw new InvitationTokenError("Invalid invitation token format");
  }
  const tokenPrefix = match[1];
  const secret = match[2];
  if (tokenPrefix === undefined || secret === undefined) {
    throw new InvitationTokenError("Invalid invitation token format");
  }
  return { token, tokenPrefix, secret };
}

/** Extract only the non-secret lookup prefix from a complete token. */
export function extractInvitationTokenPrefix(input: unknown): string {
  return parseInvitationToken(input).tokenPrefix;
}

/** Validate a persisted, non-secret token prefix. */
export function validateInvitationTokenPrefix(input: unknown): string {
  if (typeof input !== "string" || !INVITATION_TOKEN_PREFIX_RE.test(input)) {
    throw new InvitationTokenError("Invalid invitation token prefix");
  }
  return input;
}

/** Validate a persisted SHA-256 token hash without accepting plaintext. */
export function validateInvitationTokenHash(input: unknown): string {
  if (typeof input !== "string" || !INVITATION_TOKEN_HASH_RE.test(input)) {
    throw new InvitationTokenError("Invalid invitation token hash");
  }
  return input;
}

/** SHA-256 hash of the complete token; only this value is persisted. */
export function hashInvitationToken(token: string): string {
  const parsed = parseInvitationToken(token);
  return createHash("sha256").update(parsed.token, "utf8").digest("hex");
}

/** Compare a presented token with a stored hash without leaking timing detail. */
export function verifyInvitationToken(
  token: string,
  storedHash: string,
): boolean {
  let candidateHash: string;
  try {
    candidateHash = hashInvitationToken(token);
    validateInvitationTokenHash(storedHash);
  } catch {
    return false;
  }
  const candidate = Buffer.from(candidateHash, "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}

/** Return a fresh seven-day expiry without mutating the supplied date. */
export function defaultInvitationExpiry(now = new Date()): Date {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new InvitationTokenError("Invitation expiry base time is invalid");
  }
  return new Date(timestamp + INVITATION_TTL_MS);
}

/** Generate a 256-bit invitation token and its persistence-safe metadata. */
export function generateInvitationToken(
  now = new Date(),
): GeneratedInvitationToken {
  const tokenPrefix = randomBytes(INVITATION_TOKEN_PREFIX_BYTES).toString(
    "hex",
  );
  const secret = randomBytes(INVITATION_TOKEN_SECRET_BYTES).toString(
    "base64url",
  );
  const token = `${INVITATION_TOKEN_PREFIX}${tokenPrefix}_${secret}`;
  return {
    token,
    tokenPrefix,
    tokenHash: hashInvitationToken(token),
    expiresAt: defaultInvitationExpiry(now),
  };
}
