import { eq, inArray, sql } from "drizzle-orm";
import { users } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";

export type UserRow = typeof users.$inferSelect;

/** Find the auth identity by a service-normalized email address. */
export async function findUserByEmail(
  db: DbOrTx,
  normalizedEmail: string,
): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(1);
  return rows[0];
}

/** Lock an auth identity while checking membership acceptance. */
export async function lockUserById(
  tx: DbTransaction,
  userId: string,
): Promise<UserRow | undefined> {
  const rows = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Batch user lookup for DTO summaries (assignees, comment authors,
 * activity actors). One query for many ids — list endpoints must never
 * fan out per-row user reads.
 */
export async function findUsersByIds(
  db: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, UserRow>> {
  const result = new Map<string, UserRow>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return result;
  }
  const rows = await db.select().from(users).where(inArray(users.id, unique));
  for (const row of rows) {
    result.set(row.id, row);
  }
  return result;
}
