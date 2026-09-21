import { and, eq } from "drizzle-orm";
import { projectEnvironments } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type EnvironmentRow = typeof projectEnvironments.$inferSelect;

export async function insertEnvironment(
  db: DbOrTx,
  values: {
    projectId: string;
    name: string;
    baseUrl?: string | null;
    isDefault?: boolean;
  },
): Promise<EnvironmentRow> {
  const rows = await db
    .insert(projectEnvironments)
    .values({
      projectId: values.projectId,
      name: values.name,
      baseUrl: values.baseUrl ?? null,
      isDefault: values.isDefault ?? false,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert project environment");
  }
  return row;
}

export async function listEnvironmentsByProject(
  db: DbOrTx,
  projectId: string,
): Promise<EnvironmentRow[]> {
  return db
    .select()
    .from(projectEnvironments)
    .where(eq(projectEnvironments.projectId, projectId));
}

export async function findEnvironmentById(
  db: DbOrTx,
  id: string,
): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .select()
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, id))
    .limit(1);
  return rows[0];
}

export async function findEnvironmentByProjectAndName(
  db: DbOrTx,
  projectId: string,
  name: string,
): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .select()
    .from(projectEnvironments)
    .where(
      and(
        eq(projectEnvironments.projectId, projectId),
        eq(projectEnvironments.name, name),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function findDefaultEnvironment(
  db: DbOrTx,
  projectId: string,
): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .select()
    .from(projectEnvironments)
    .where(
      and(
        eq(projectEnvironments.projectId, projectId),
        eq(projectEnvironments.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function updateEnvironmentRow(
  db: DbOrTx,
  id: string,
  patch: { name?: string; baseUrl?: string | null; isDefault?: boolean },
): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .update(projectEnvironments)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projectEnvironments.id, id))
    .returning();
  return rows[0];
}

export async function clearDefaultEnvironments(
  db: DbOrTx,
  projectId: string,
): Promise<void> {
  await db
    .update(projectEnvironments)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectEnvironments.projectId, projectId),
        eq(projectEnvironments.isDefault, true),
      ),
    );
}

export async function deleteEnvironmentRow(
  db: DbOrTx,
  id: string,
): Promise<void> {
  await db.delete(projectEnvironments).where(eq(projectEnvironments.id, id));
}
