import { eq } from "drizzle-orm";
import { workspaces } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type WorkspaceRow = typeof workspaces.$inferSelect;

export async function insertWorkspace(
  db: DbOrTx,
  values: { name: string; slug: string; createdByUserId: string },
): Promise<WorkspaceRow> {
  const rows = await db
    .insert(workspaces)
    .values({
      name: values.name,
      slug: values.slug,
      createdByUserId: values.createdByUserId,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert workspace");
  }
  return row;
}

export async function findWorkspaceById(
  db: DbOrTx,
  id: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return rows[0];
}

/** Lock the tenant row before any governance membership mutation. */
export async function lockWorkspaceById(
  tx: DbTransaction,
  id: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

export async function findWorkspaceBySlug(
  db: DbOrTx,
  slug: string,
): Promise<WorkspaceRow | undefined> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return rows[0];
}

export async function deleteWorkspaceRow(
  tx: DbTransaction,
  id: string,
): Promise<void> {
  await tx.delete(workspaces).where(eq(workspaces.id, id));
}

export async function updateWorkspaceRow(
  db: DbOrTx,
  id: string,
  patch: { name?: string; slug?: string },
): Promise<WorkspaceRow | undefined> {
  const rows = await db
    .update(workspaces)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, id))
    .returning();
  return rows[0];
}
