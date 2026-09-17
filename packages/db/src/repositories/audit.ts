import { desc, eq } from "drizzle-orm";
import { auditLogs } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type AuditRow = typeof auditLogs.$inferSelect;

export type AuditAction =
  | "workspace.created"
  | "workspace.updated"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project_origin.created"
  | "project_origin.updated"
  | "project_origin.deleted"
  | "project_key.rotated";

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "key",
]);

function sanitizeMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    let leaked = false;
    for (const s of SENSITIVE_KEYS) {
      if (lower.includes(s)) {
        leaked = true;
        break;
      }
    }
    if (leaked) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (
      typeof v === "string" &&
      (lower.includes("hash") || lower.includes("secret"))
    ) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = sanitizeMetadata(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
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
      metadataJson: sanitizeMetadata(values.metadataJson ?? {}),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert audit log");
  }
  return row;
}

export async function listAuditByWorkspace(
  db: DbOrTx,
  workspaceId: string,
  limit = 100,
): Promise<AuditRow[]> {
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, workspaceId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
