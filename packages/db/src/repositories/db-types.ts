import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { schema } from "../schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type DbOrTx = Database | DbTransaction;

export function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
