import { and, eq, isNull } from "drizzle-orm";
import { projectKeys } from "../schema.js";
import { parseSecretToken, verifySecretToken } from "../keys-crypto.js";
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

/**
 * RS-02: record successful CLI authentication on a secret token.
 * Called only after verification succeeds (see verifyAndTouchSecretKey);
 * never invoked on failed attempts so `last_used_at` stays an honest
 * success marker.
 */
export async function touchKeyLastUsedAt(
  db: DbOrTx,
  id: string,
  at: Date,
): Promise<void> {
  await db
    .update(projectKeys)
    .set({ lastUsedAt: at })
    .where(eq(projectKeys.id, id));
}

/**
 * RS-02: verify a candidate secret token against the active `secret` row
 * for a project. Fail-closed: malformed candidates, unknown prefixes,
 * revoked rows, cross-project rows and public-ingest rows all yield null
 * instead of throwing, and the timing-safe comparison runs only for
 * well-formed same-project secret candidates.
 */
export async function verifyActiveSecretKey(
  db: DbOrTx,
  projectId: string,
  candidate: string,
): Promise<ProjectKeyRow | null> {
  let prefix: string;
  try {
    prefix = parseSecretToken(candidate).prefix;
  } catch {
    return null;
  }
  const row = await findKeyByPrefix(db, prefix);
  if (row === undefined) {
    return null;
  }
  if (row.projectId !== projectId) {
    return null;
  }
  if (row.kind !== "secret") {
    return null;
  }
  if (row.revokedAt !== null) {
    return null;
  }
  const valid = verifySecretToken(candidate, row.keyHash);
  if (!valid) {
    return null;
  }
  return row;
}

/**
 * RS-02: verify a secret token and, only on success, stamp `last_used_at`.
 * Returns the touched row on success, null on any failure without touching
 * any row. The CLI auth boundary (RS-03) calls this helper; the middleware
 * itself lives outside RS-02 scope.
 */
export async function verifyAndTouchSecretKey(
  db: DbOrTx,
  projectId: string,
  candidate: string,
  now: Date = new Date(),
): Promise<ProjectKeyRow | null> {
  const row = await verifyActiveSecretKey(db, projectId, candidate);
  if (row === null) {
    return null;
  }
  await touchKeyLastUsedAt(db, row.id, now);
  const refreshed = await findKeyById(db, row.id);
  return refreshed ?? row;
}
