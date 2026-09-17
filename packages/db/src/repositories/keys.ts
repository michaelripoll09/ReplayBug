import { and, eq, isNull } from "drizzle-orm";
import { projectKeys } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type ProjectKeyRow = typeof projectKeys.$inferSelect;

export async function insertProjectKey(
  db: DbOrTx,
  values: {
    projectId: string;
    kind: string;
    name: string;
    prefix: string;
    keyHash: string;
  },
): Promise<ProjectKeyRow> {
  const rows = await db
    .insert(projectKeys)
    .values({
      projectId: values.projectId,
      kind: values.kind,
      name: values.name,
      prefix: values.prefix,
      keyHash: values.keyHash,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert project key");
  }
  return row;
}

export async function listKeysByProject(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectKeyRow[]> {
  return db
    .select()
    .from(projectKeys)
    .where(eq(projectKeys.projectId, projectId));
}

export async function listActiveKeysByProjectAndKind(
  db: DbOrTx,
  projectId: string,
  kind: string,
): Promise<ProjectKeyRow[]> {
  return db
    .select()
    .from(projectKeys)
    .where(
      and(
        eq(projectKeys.projectId, projectId),
        eq(projectKeys.kind, kind),
        isNull(projectKeys.revokedAt),
      ),
    );
}

export async function findKeyByPrefix(
  db: DbOrTx,
  prefix: string,
): Promise<ProjectKeyRow | undefined> {
  const rows = await db
    .select()
    .from(projectKeys)
    .where(eq(projectKeys.prefix, prefix))
    .limit(1);
  return rows[0];
}

export async function findKeyById(
  db: DbOrTx,
  id: string,
): Promise<ProjectKeyRow | undefined> {
  const rows = await db
    .select()
    .from(projectKeys)
    .where(eq(projectKeys.id, id))
    .limit(1);
  return rows[0];
}

export async function revokeKeyById(
  db: DbOrTx,
  id: string,
  revokedAt: Date,
): Promise<ProjectKeyRow | undefined> {
  const rows = await db
    .update(projectKeys)
    .set({ revokedAt })
    .where(eq(projectKeys.id, id))
    .returning();
  return rows[0];
}
