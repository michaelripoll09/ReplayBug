import { and, asc, eq } from "drizzle-orm";
import { projects } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export const MIN_PROJECT_RETENTION_DAYS = 7;
export const MAX_PROJECT_RETENTION_DAYS = 365;
export const PROJECT_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

export type ProjectRow = typeof projects.$inferSelect;

/**
 * Computes a project retention cutoff from a UTC instant.
 *
 * Dates are stored as instants, so subtracting whole UTC days is independent
 * of the host timezone and matches the database retention predicate.
 */
export function computeProjectRetentionCutoff(
  now: Date,
  retentionDays: number,
): Date {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("Retention cleanup now must be a valid date");
  }
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_PROJECT_RETENTION_DAYS ||
    retentionDays > MAX_PROJECT_RETENTION_DAYS
  ) {
    throw new RangeError(
      `Project retention days must be an integer between ${MIN_PROJECT_RETENTION_DAYS} and ${MAX_PROJECT_RETENTION_DAYS}`,
    );
  }
  return new Date(now.getTime() - retentionDays * PROJECT_RETENTION_DAY_MS);
}

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

/** Lock one project row before destructive lifecycle work. */
export async function lockProjectById(
  tx: DbTransaction,
  id: string,
): Promise<ProjectRow | undefined> {
  const rows = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
    .for("update");
  return rows[0];
}

/** Lock all projects in deterministic id order for workspace deletion. */
export async function lockProjectsByWorkspace(
  tx: DbTransaction,
  workspaceId: string,
): Promise<ProjectRow[]> {
  return tx
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .orderBy(asc(projects.id))
    .for("update");
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
