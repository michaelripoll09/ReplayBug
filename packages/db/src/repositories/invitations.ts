import { and, asc, desc, eq, gt, isNull, lte } from "drizzle-orm";
import {
  extractInvitationTokenPrefix,
  normalizeInvitationEmail,
  validateInvitationRole,
  validateInvitationTokenHash,
  validateInvitationTokenPrefix,
  type InvitationRole,
} from "../invitations.js";
import { workspaceInvitations } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type InvitationRow = typeof workspaceInvitations.$inferSelect;
export type InvitationMetadataRow = Omit<InvitationRow, "tokenHash">;
export type InvitationTokenLookupRow = Pick<
  InvitationRow,
  | "id"
  | "workspaceId"
  | "email"
  | "role"
  | "tokenHash"
  | "tokenPrefix"
  | "expiresAt"
  | "acceptedAt"
  | "revokedAt"
  | "createdAt"
>;

export const MAX_INVITATION_QUERY_LIMIT = 100;
export const MAX_INVITATION_TOKEN_CANDIDATES = 20;
export const MAX_EXPIRED_INVITATION_RETIRE_LIMIT = 100;

const invitationMetadataColumns = {
  id: workspaceInvitations.id,
  workspaceId: workspaceInvitations.workspaceId,
  email: workspaceInvitations.email,
  role: workspaceInvitations.role,
  tokenPrefix: workspaceInvitations.tokenPrefix,
  expiresAt: workspaceInvitations.expiresAt,
  acceptedAt: workspaceInvitations.acceptedAt,
  revokedAt: workspaceInvitations.revokedAt,
  createdByUserId: workspaceInvitations.createdByUserId,
  createdAt: workspaceInvitations.createdAt,
};

const invitationTokenLookupColumns = {
  id: workspaceInvitations.id,
  workspaceId: workspaceInvitations.workspaceId,
  email: workspaceInvitations.email,
  role: workspaceInvitations.role,
  tokenHash: workspaceInvitations.tokenHash,
  tokenPrefix: workspaceInvitations.tokenPrefix,
  expiresAt: workspaceInvitations.expiresAt,
  acceptedAt: workspaceInvitations.acceptedAt,
  revokedAt: workspaceInvitations.revokedAt,
  createdAt: workspaceInvitations.createdAt,
};

function boundedLimit(limit: number, maximum: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(
      `Query limit must be an integer between 1 and ${maximum}`,
    );
  }
  return limit;
}

function assertNormalizedInvitationEmail(email: string): string {
  if (
    email.length < 3 ||
    email.length > 320 ||
    email !== email.trim() ||
    email !== email.toLowerCase() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  ) {
    throw new TypeError("Invitation email must be normalized");
  }
  return email;
}

export interface InsertInvitationInput {
  workspaceId: string;
  /** Service-normalized email; repository validation never rewrites it. */
  email: string;
  role: InvitationRole;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date;
  createdByUserId: string;
}

/** Insert only persistence-safe invitation fields; plaintext is not accepted. */
export async function insertInvitation(
  db: DbOrTx,
  input: InsertInvitationInput,
): Promise<InvitationRow> {
  const email = assertNormalizedInvitationEmail(input.email);
  const role: InvitationRole = validateInvitationRole(input.role);
  const tokenHash = validateInvitationTokenHash(input.tokenHash);
  const tokenPrefix = validateInvitationTokenPrefix(input.tokenPrefix);
  const rows = await db
    .insert(workspaceInvitations)
    .values({
      workspaceId: input.workspaceId,
      email,
      role,
      tokenHash,
      tokenPrefix,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert workspace invitation");
  }
  return row;
}

export async function findInvitationById(
  db: DbOrTx,
  invitationId: string,
): Promise<InvitationRow | undefined> {
  const rows = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId))
    .limit(1);
  return rows[0];
}

/** Lock one invitation for accept/revoke transactions. */
export async function lockInvitationById(
  tx: DbTransaction,
  invitationId: string,
): Promise<InvitationRow | undefined> {
  const rows = await tx
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId))
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Prefix lookup returns hashes only to trusted transaction code. API-facing
 * listing uses listInvitationMetadataByWorkspace, which omits token_hash.
 */
export async function findInvitationCandidatesByTokenPrefix(
  db: DbOrTx,
  tokenPrefix: string,
  limit = MAX_INVITATION_TOKEN_CANDIDATES,
): Promise<InvitationTokenLookupRow[]> {
  const prefix = validateInvitationTokenPrefix(tokenPrefix);
  return db
    .select(invitationTokenLookupColumns)
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.tokenPrefix, prefix))
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(boundedLimit(limit, MAX_INVITATION_TOKEN_CANDIDATES));
}

/** Prefix lookup with row locks for one-time acceptance transactions. */
export async function lockInvitationCandidatesByTokenPrefix(
  tx: DbTransaction,
  tokenPrefix: string,
  limit = MAX_INVITATION_TOKEN_CANDIDATES,
): Promise<InvitationTokenLookupRow[]> {
  const prefix = validateInvitationTokenPrefix(tokenPrefix);
  return tx
    .select(invitationTokenLookupColumns)
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.tokenPrefix, prefix))
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(boundedLimit(limit, MAX_INVITATION_TOKEN_CANDIDATES))
    .for("update");
}

/** Find a still-valid pending invite for repository-level duplicate checks. */
export async function findActiveInvitationByWorkspaceEmail(
  db: DbOrTx,
  workspaceId: string,
  email: unknown,
  now = new Date(),
): Promise<InvitationRow | undefined> {
  const normalizedEmail = normalizeInvitationEmail(email);
  const rows = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.email, normalizedEmail),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        gt(workspaceInvitations.expiresAt, now),
      ),
    )
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(1);
  return rows[0];
}

/** Lock the active duplicate check inside an invitation creation transaction. */
export async function lockActiveInvitationByWorkspaceEmail(
  tx: DbTransaction,
  workspaceId: string,
  normalizedEmail: string,
  now = new Date(),
): Promise<InvitationRow | undefined> {
  const email = assertNormalizedInvitationEmail(normalizedEmail);
  const rows = await tx
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.email, email),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        gt(workspaceInvitations.expiresAt, now),
      ),
    )
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(1)
    .for("update");
  return rows[0];
}

export interface ExpiredInvitationCleanupOptions {
  workspaceId?: string;
  email?: string;
  now?: Date;
  limit?: number;
}

function expiredInvitationConditions(
  options: ExpiredInvitationCleanupOptions,
): ReturnType<typeof isNull>[] {
  const now = options.now ?? new Date();
  const conditions = [
    isNull(workspaceInvitations.acceptedAt),
    isNull(workspaceInvitations.revokedAt),
    lte(workspaceInvitations.expiresAt, now),
  ];
  if (options.workspaceId !== undefined) {
    conditions.push(eq(workspaceInvitations.workspaceId, options.workspaceId));
  }
  if (options.email !== undefined) {
    conditions.push(eq(workspaceInvitations.email, options.email));
  }
  return conditions;
}

/** Bounded expired-pending selection for RET-04 and reissue transactions. */
export async function listExpiredPendingInvitations(
  db: DbOrTx,
  options: ExpiredInvitationCleanupOptions = {},
): Promise<InvitationRow[]> {
  const limit = boundedLimit(
    options.limit ?? MAX_EXPIRED_INVITATION_RETIRE_LIMIT,
    MAX_EXPIRED_INVITATION_RETIRE_LIMIT,
  );
  return db
    .select()
    .from(workspaceInvitations)
    .where(and(...expiredInvitationConditions(options)))
    .orderBy(asc(workspaceInvitations.expiresAt), asc(workspaceInvitations.id))
    .limit(limit);
}

/** Lock a bounded expired-pending batch before retiring it. */
export async function lockExpiredPendingInvitations(
  tx: DbTransaction,
  options: ExpiredInvitationCleanupOptions = {},
): Promise<InvitationRow[]> {
  const limit = boundedLimit(
    options.limit ?? MAX_EXPIRED_INVITATION_RETIRE_LIMIT,
    MAX_EXPIRED_INVITATION_RETIRE_LIMIT,
  );
  return tx
    .select()
    .from(workspaceInvitations)
    .where(and(...expiredInvitationConditions(options)))
    .orderBy(asc(workspaceInvitations.expiresAt), asc(workspaceInvitations.id))
    .limit(limit)
    .for("update", { skipLocked: true });
}

/**
 * Retire expired pending rows by setting revoked_at. History is preserved and
 * the partial pending-email uniqueness index is released for safe reissue.
 */
export async function retireExpiredPendingInvitations(
  tx: DbTransaction,
  options: ExpiredInvitationCleanupOptions = {},
): Promise<InvitationRow[]> {
  const candidates = await lockExpiredPendingInvitations(tx, options);
  const retired: InvitationRow[] = [];
  const now = options.now ?? new Date();
  for (const candidate of candidates) {
    const rows = await tx
      .update(workspaceInvitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(workspaceInvitations.id, candidate.id),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          lte(workspaceInvitations.expiresAt, now),
        ),
      )
      .returning();
    const row = rows[0];
    if (row !== undefined) {
      retired.push(row);
    }
  }
  return retired;
}

/** Mark a locked pending invitation accepted exactly once. */
export async function markInvitationAccepted(
  tx: DbTransaction,
  invitationId: string,
  acceptedAt: Date,
): Promise<InvitationRow | undefined> {
  const rows = await tx
    .update(workspaceInvitations)
    .set({ acceptedAt })
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        gt(workspaceInvitations.expiresAt, acceptedAt),
      ),
    )
    .returning();
  return rows[0];
}

/** Revoke a pending invitation exactly once; repeated calls are no-ops. */
export async function markInvitationRevoked(
  tx: DbTransaction,
  invitationId: string,
  revokedAt: Date,
): Promise<InvitationRow | undefined> {
  const rows = await tx
    .update(workspaceInvitations)
    .set({ revokedAt })
    .where(
      and(
        eq(workspaceInvitations.id, invitationId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        gt(workspaceInvitations.expiresAt, revokedAt),
      ),
    )
    .returning();
  return rows[0];
}

/** Safe invitation metadata list: hashes and all token material are omitted. */
export async function listInvitationMetadataByWorkspace(
  db: DbOrTx,
  workspaceId: string,
  limit = MAX_INVITATION_QUERY_LIMIT,
): Promise<InvitationMetadataRow[]> {
  return db
    .select(invitationMetadataColumns)
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId))
    .orderBy(desc(workspaceInvitations.createdAt), asc(workspaceInvitations.id))
    .limit(boundedLimit(limit, MAX_INVITATION_QUERY_LIMIT));
}

/** Re-validate a prefix extracted from a complete token before a lookup. */
export function invitationTokenPrefixForLookup(token: string): string {
  return validateInvitationTokenPrefix(extractInvitationTokenPrefix(token));
}
