import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface E2EFixture {
  dsn: string;
  projectId: string;
  origin: string;
}

/** Fixture written by e2e/seed.mjs before Playwright starts. */
export function e2eFixture(): E2EFixture {
  const raw = readFileSync(join(HERE, "..", ".e2e", "dsn.json"), "utf8");
  return JSON.parse(raw) as E2EFixture;
}

export async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const url =
    process.env["REPLAYBUG_DATABASE_URL"] ??
    "postgres://replaybug:replaybug@localhost:5544/replaybug";
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Polls until fn returns a non-null value or the timeout elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    last = result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms (last=${last})`);
}

/** Serialized persisted telemetry (sessions + events) for leak scanning. */
export async function persistedTelemetryJson(
  projectId: string,
): Promise<string> {
  return withPool(async (pool) => {
    const sessions = await pool.query(
      `SELECT row_to_json(t) AS row FROM telemetry_sessions t WHERE project_id = $1`,
      [projectId],
    );
    const events = await pool.query(
      `SELECT row_to_json(t) AS row FROM events t WHERE project_id = $1`,
      [projectId],
    );
    return JSON.stringify([...sessions.rows, ...events.rows]);
  });
}
