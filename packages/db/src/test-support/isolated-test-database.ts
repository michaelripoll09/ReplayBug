import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDbClient, type DbClient } from "../client.js";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://replaybug:replaybug@localhost:5544/replaybug";
const SUITE_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/;
const MAX_DATABASE_NAME_LENGTH = 63;
const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

export interface IsolatedTestDatabase {
  databaseUrl: string;
  databaseName: string;
  client: DbClient;
  cleanup(): Promise<void>;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_$-]*$/.test(identifier)) {
    throw new Error("unsafe PostgreSQL identifier");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateSuite(suite: string): string {
  if (!SUITE_PATTERN.test(suite)) {
    throw new Error(
      "suite must be 1-16 characters and contain only lowercase letters, digits, underscores, or hyphens",
    );
  }
  return suite;
}

function adminDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("REPLAYBUG_DATABASE_URL must use PostgreSQL");
  }
  parsed.pathname = "/postgres";
  return parsed.toString();
}

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export async function createIsolatedTestDatabase({
  suite,
}: {
  suite: string;
}): Promise<IsolatedTestDatabase> {
  const safeSuite = validateSuite(suite);
  const baseUrl =
    process.env["REPLAYBUG_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;
  const suffix = randomBytes(10).toString("hex");
  const databaseName = `replaybug_test_${safeSuite}_${process.pid}_${suffix}`;
  if (databaseName.length > MAX_DATABASE_NAME_LENGTH) {
    throw new Error("generated test database name is too long");
  }
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const adminPool = new Pool({
    connectionString: adminDatabaseUrl(baseUrl),
    max: 1,
  });
  let client: DbClient | undefined;
  let created = false;
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    try {
      try {
        if (client) await client.close();
      } catch (error) {
        firstError = error;
      }
      try {
        if (created) {
          await adminPool.query(
            `DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`,
          );
        }
      } catch (error) {
        firstError ??= error;
      }
    } finally {
      try {
        await adminPool.end();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };

  try {
    await adminPool.query(`CREATE DATABASE ${quotedDatabaseName}`);
    created = true;
    const isolatedUrl = databaseUrlFor(baseUrl, databaseName);
    client = createDbClient({
      databaseUrl: isolatedUrl,
      maxConnections: 5,
      connectionTimeoutMs: 5000,
    });
    await migrate(drizzle(client.pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    return { databaseUrl: isolatedUrl, databaseName, client, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
