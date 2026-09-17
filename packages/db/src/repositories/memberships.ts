import { and, eq } from "drizzle-orm";
import { workspaceMemberships } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

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
