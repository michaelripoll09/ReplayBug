import { and, eq } from "drizzle-orm";
import { projects } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type ProjectRow = typeof projects.$inferSelect;

export async function insertProject(
  db: DbOrTx,
  values: {
    workspaceId: string;
    name: string;
    slug: string;
    description?: string | null;
    timezone?: string;
    retentionDays?: number;
  },
): Promise<ProjectRow> {
  const rows = await db
    .insert(projects)
    .values({
      workspaceId: values.workspaceId,
      name: values.name,
      slug: values.slug,
      description: values.description ?? null,
      timezone: values.timezone ?? "UTC",
      retentionDays: values.retentionDays ?? 30,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert project");
  }
  return row;
}

export async function findProjectById(
  db: DbOrTx,
  id: string,
): Promise<ProjectRow | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return rows[0];
}

export async function findProjectByWorkspaceAndSlug(
  db: DbOrTx,
  workspaceId: string,
  slug: string,
): Promise<ProjectRow | undefined> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.slug, slug)))
    .limit(1);
  return rows[0];
}

export async function listProjectsByWorkspace(
  db: DbOrTx,
  workspaceId: string,
): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId));
}

export async function updateProjectRow(
  db: DbOrTx,
  id: string,
  patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    timezone?: string;
    retentionDays?: number;
  },
): Promise<ProjectRow | undefined> {
  const rows = await db
    .update(projects)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.retentionDays !== undefined
        ? { retentionDays: patch.retentionDays }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning();
  return rows[0];
}

export async function deleteProjectRow(db: DbOrTx, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}
