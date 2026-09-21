import { and, asc, eq, inArray } from "drizzle-orm";
import { workspaceMemberships } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type MembershipRow = typeof workspaceMemberships.$inferSelect;

export async function insertMembership(
  db: DbOrTx,
  values: { workspaceId: string; userId: string; role: string },
): Promise<MembershipRow> {
  const rows = await db
    .insert(workspaceMemberships)
    .values({
      workspaceId: values.workspaceId,
      userId: values.userId,
      role: values.role,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert workspace membership");
  }
  return row;
}

export async function findMembership(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const rows = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Lock the membership row while accepting an invitation. */
export async function lockMembership(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const rows = await tx
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Lock all memberships for a workspace in a deterministic id order.
 * Governance transactions lock the workspace row before calling this helper,
 * so role changes, removals, leave, and ownership transfer serialize on the
 * same tenant boundary.
 */
export async function lockMembershipsByWorkspace(
  tx: DbTransaction,
  workspaceId: string,
  userIds?: readonly string[],
): Promise<MembershipRow[]> {
  if (userIds !== undefined && userIds.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        ...(userIds === undefined
          ? []
          : [inArray(workspaceMemberships.userId, userIds)]),
      ),
    )
    .orderBy(asc(workspaceMemberships.id))
    .for("update");
}

export async function updateMembershipRole(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<MembershipRow | undefined> {
  const rows = await tx
    .update(workspaceMemberships)
    .set({ role })
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .returning();
  return rows[0];
}

export async function deleteMembership(
  tx: DbTransaction,
  workspaceId: string,
  userId: string,
): Promise<MembershipRow | undefined> {
  const rows = await tx
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    )
    .returning();
  return rows[0];
}

export async function listMembershipsByWorkspace(
  db: DbOrTx,
  workspaceId: string,
): Promise<MembershipRow[]> {
  return db
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspaceId));
}

export async function listMembershipsByUser(
  db: DbOrTx,
  userId: string,
): Promise<MembershipRow[]> {
  return db
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId));
}
