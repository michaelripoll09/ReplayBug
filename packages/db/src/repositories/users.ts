import { inArray } from "drizzle-orm";
import { users } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type UserRow = typeof users.$inferSelect;

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
