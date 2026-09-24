import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  sql,
  type SQL,
} from "drizzle-orm";
import { auditLogs } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type AuditRow = typeof auditLogs.$inferSelect;

export const AUDIT_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.ownership_transferred",
  "workspace.deletion_requested",
  "workspace.deletion_completed",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.retention_changed",
  "project.deletion_requested",
  "project.deletion_completed",
  "workspace_invitation.created",
  "workspace_invitation.revoked",
  "workspace_invitation.accepted",
  "workspace_member.role_changed",
  "workspace_member.removed",
  "project_origin.created",
  "project_origin.updated",
  "project_origin.deleted",
  "project_key.rotated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "key",
  "credential",
  "credentials",
  "hash",
  "error",
  "stack",
  "sql",
  "query",
  "connection",
]);
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_ITEMS = 50;
const MAX_METADATA_STRING_LENGTH = 2048;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

function hasSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const sensitive of SENSITIVE_KEYS) {
    if (lower.includes(sensitive)) {
      return true;
    }
  }
  return false;
}

function looksLikeSecret(value: string): boolean {
  return (
    /^rb_(?:sk|inv)_[A-Za-z0-9_-]+$/u.test(value) ||
    /^[0-9a-f]{64}$/u.test(value)
  );
}

function sanitizeAuditValue(
  value: unknown,
  key: string,
  depth: number,
): unknown {
  if (hasSensitiveKey(key)) {
    return REDACTED;
  }
  if (depth > MAX_METADATA_DEPTH) {
    return REDACTED;
  }
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      return REDACTED;
    }
    return value.length > MAX_METADATA_STRING_LENGTH
      ? `${value.slice(0, MAX_METADATA_STRING_LENGTH - 1)}…`
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : REDACTED;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_METADATA_ITEMS)
      .map((item) => sanitizeAuditValue(item, "", depth + 1));
    if (value.length > MAX_METADATA_ITEMS) {
      items.push(TRUNCATED);
    }
    return items;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of entries.slice(0, MAX_METADATA_KEYS)) {
      out[entryKey] = sanitizeAuditValue(entryValue, entryKey, depth + 1);
    }
    if (entries.length > MAX_METADATA_KEYS) {
      out["_truncated"] = true;
    }
    return out;
  }
  return REDACTED;
}

/**
 * Sanitize metadata both when writing and when projecting an older row. This
 * handles nested objects/arrays, bounds user-controlled strings, and drops
 * token/hash-shaped values even when a caller chose a misleading key.
 */
export function sanitizeAuditMetadata(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const value = sanitizeAuditValue(input, "", 0);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function insertAuditLog(
  db: DbOrTx,
  values: {
    workspaceId: string;
    projectId?: string | null;
    actorUserId?: string | null;
    action: AuditAction;
    metadataJson?: Record<string, unknown>;
  },
): Promise<AuditRow> {
  const rows = await db
    .insert(auditLogs)
    .values({
      workspaceId: values.workspaceId,
      projectId: values.projectId ?? null,
      actorUserId: values.actorUserId ?? null,
      action: values.action,
      metadataJson: sanitizeAuditMetadata(values.metadataJson ?? {}),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert audit log");
  }
  return row;
}

function boundedLimit(limit: number, maximum: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(
      `Query limit must be an integer between 1 and ${maximum}`,
    );
  }
  return limit;
}

export const MAX_AUDIT_QUERY_LIMIT = 100;

export interface AuditCursor {
  createdAt: string;
  id: string;
}

const AUDIT_CURSOR_VERSION = 1;

/** Opaque cursor over (created_at DESC, id ASC). */
export function encodeAuditCursor(createdAt: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: AUDIT_CURSOR_VERSION, createdAt, id }),
    "utf8",
  ).toString("base64url");
}

export function decodeAuditCursor(raw: string): AuditCursor | null {
  if (raw.length < 1 || raw.length > 256) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== AUDIT_CURSOR_VERSION ||
      typeof record["createdAt"] !== "string" ||
      Number.isNaN(Date.parse(record["createdAt"])) ||
      typeof record["id"] !== "string" ||
      record["id"].length < 1 ||
      record["id"].length > 200
    ) {
      return null;
    }
    return { createdAt: record["createdAt"], id: record["id"] };
  } catch {
    return null;
  }
}

export interface ListAuditInput {
  workspaceId: string;
  limit: number;
  cursor?: AuditCursor;
  action?: AuditAction;
}

export interface ListAuditResult {
  rows: AuditRow[];
  nextCursor: string | null;
}

/**
 * Newest-first audit page with a stable timestamp/id keyset.
 *
 * `audit_logs.created_at` is timestamptz (microsecond precision) while
 * JavaScript Date round-trips milliseconds. Deriving the cursor from
 * `Date.toISOString()` truncates sub-millisecond precision, so two rows
 * inside the same millisecond would sort strictly above the truncated
 * cursor and the keyset predicate would skip the remaining row. The cursor
 * timestamp is therefore produced by PostgreSQL itself at microsecond
 * precision in the same SELECT, and the decoded cursor string is passed
 * back to PostgreSQL verbatim (never through JavaScript Date) so the
 * microseconds survive end-to-end.
 */
export async function listAuditByWorkspacePaged(
  db: DbOrTx,
  input: ListAuditInput,
): Promise<ListAuditResult> {
  const conditions: SQL[] = [eq(auditLogs.workspaceId, input.workspaceId)];
  if (input.action !== undefined) {
    conditions.push(eq(auditLogs.action, input.action));
  }
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${auditLogs.createdAt} < ${input.cursor.createdAt}
      OR (${auditLogs.createdAt} = ${input.cursor.createdAt}
          AND ${auditLogs.id} > ${input.cursor.id})
    )`);
  }
  const limit = boundedLimit(input.limit, MAX_AUDIT_QUERY_LIMIT);
  const rows = await db
    .select({
      ...getTableColumns(auditLogs),
      cursorCreatedAt: sql<string>`to_char(${auditLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(limit + 1);

  // Strip the cursor-only computed field: callers keep the AuditRow shape.
  const page: AuditRow[] = rows
    .slice(0, limit)
    .map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row);
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    if (last !== undefined) {
      nextCursor = encodeAuditCursor(last.cursorCreatedAt, last.id);
    }
  }
  return { rows: page, nextCursor };
}

/** Backward-compatible numeric list used by older callers. */
export async function listAuditByWorkspace(
  db: DbOrTx,
  workspaceId: string,
  limit = MAX_AUDIT_QUERY_LIMIT,
): Promise<AuditRow[]> {
  const result = await listAuditByWorkspacePaged(db, {
    workspaceId,
    limit,
  });
  return result.rows;
}
