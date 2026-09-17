import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { type DbConfig } from "./config.js";
import { schema } from "./schema.js";

export interface DbClient {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  close(): Promise<void>;
}

/** Minimal queryable surface needed by health checks (real pg Pool or a mock). */
export interface HealthCheckable {
  query(text: string): Promise<unknown>;
}

/**
 * Create a centralized PostgreSQL client: a pg Pool wrapped with Drizzle.
 * Callers share this factory instead of constructing pools ad hoc so
 * connection limits, timeouts and graceful shutdown stay consistent.
 */
export function createDbClient(config: DbConfig): DbClient {
  const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
  };
  const pool = new Pool(poolConfig);
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Lightweight database health probe used by GET /health/ready.
 * Returns true when `SELECT 1` succeeds, false on any error so readiness
 * degrades to 503 instead of throwing.
 */
export async function checkDbHealth(
  target: HealthCheckable,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const result = await Promise.race([
      target.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("db health check timed out")),
          timeoutMs,
        );
      }),
    ]);
    void result;
    return true;
  } catch {
    return false;
  }
}
