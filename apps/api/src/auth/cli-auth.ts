import { ProjectKeyRepo, parseSecretToken, type Database } from "@replaybug/db";

/**
 * RS-03 CLI auth boundary: project-scoped `rb_sk_…` bearer authentication.
 *
 * - Bearer-only via the `Authorization` header. Credentials in query strings
 *   are never read, so `?token=…` can never authenticate.
 * - Session cookies are never consulted here: token routes stay clearly
 *   separated from session-cookie dashboard mutations.
 * - The full token is never logged, never returned and never embedded in
 *   error details.
 */

export interface CliPrincipal {
  kind: "project-token";
  projectId: string;
  tokenId: string;
}

/**
 * Strict `Authorization: Bearer <token>` extraction.
 * Returns the raw token candidate or null when the header is missing,
 * uses another scheme, or carries an empty credential.
 * The scheme name is case-sensitive (`Bearer` only).
 */
export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | null {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) {
    return null;
  }
  const candidate = (match[1] ?? "").trim();
  if (candidate.length === 0) {
    return null;
  }
  return candidate;
}

/**
 * Authenticate a CLI request bearer credential.
 *
 * Flow: parse `rb_sk_` token → prefix lookup to derive the owning project →
 * timing-safe hash verification via RS-02's `verifyAndTouchSecretKey`
 * (which stamps `last_used_at` only on success and enforces kind=secret +
 * active/not-revoked). Returns a safe project-token principal carrying only
 * the project id and token id, or null on any failure without throwing.
 */
export async function authenticateCliToken(
  db: Database,
  authorization: string | string[] | undefined,
): Promise<CliPrincipal | null> {
  const candidate = extractBearerToken(authorization);
  if (candidate === null) {
    return null;
  }
  let prefix: string;
  try {
    prefix = parseSecretToken(candidate).prefix;
  } catch {
    return null;
  }
  // Derive the owning project from the prefix row. The row itself is
  // untrusted here: kind/revocation/hash are re-checked inside
  // `verifyAndTouchSecretKey`, which fails closed on every mismatch.
  const located = await ProjectKeyRepo.findKeyByPrefix(db, prefix);
  if (located === undefined) {
    return null;
  }
  const verified = await ProjectKeyRepo.verifyAndTouchSecretKey(
    db,
    located.projectId,
    candidate,
  );
  if (verified === null) {
    return null;
  }
  return {
    kind: "project-token",
    projectId: verified.projectId,
    tokenId: verified.id,
  };
}
