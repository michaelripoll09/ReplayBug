import { eq } from "drizzle-orm";
import { projectOrigins } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type OriginRow = typeof projectOrigins.$inferSelect;

export async function insertOrigin(
  db: DbOrTx,
  values: { projectId: string; origin: string; isEnabled?: boolean },
): Promise<OriginRow> {
  const rows = await db
    .insert(projectOrigins)
    .values({
      projectId: values.projectId,
      origin: values.origin,
      isEnabled: values.isEnabled ?? true,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert project origin");
  }
  return row;
}

export async function listOriginsByProject(
  db: DbOrTx,
  projectId: string,
): Promise<OriginRow[]> {
  return db
    .select()
    .from(projectOrigins)
    .where(eq(projectOrigins.projectId, projectId));
}

export async function findOriginById(
  db: DbOrTx,
  id: string,
): Promise<OriginRow | undefined> {
  const rows = await db
    .select()
    .from(projectOrigins)
    .where(eq(projectOrigins.id, id))
    .limit(1);
  return rows[0];
}

export async function updateOriginRow(
  db: DbOrTx,
  id: string,
  patch: { origin?: string; isEnabled?: boolean },
): Promise<OriginRow | undefined> {
  const rows = await db
    .update(projectOrigins)
    .set({
      ...(patch.origin !== undefined ? { origin: patch.origin } : {}),
      ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projectOrigins.id, id))
    .returning();
  return rows[0];
}

export async function deleteOriginRow(db: DbOrTx, id: string): Promise<void> {
  await db.delete(projectOrigins).where(eq(projectOrigins.id, id));
}
