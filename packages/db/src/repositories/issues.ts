import { and, eq, sql } from "drizzle-orm";
import { issues } from "../schema.js";
import type { DbOrTx, DbTransaction } from "./db-types.js";
import type { IssueSeverity, IssueType } from "../domain/fingerprint.js";

export type IssueRow = typeof issues.$inferSelect;

export const ISSUE_STATUSES = [
  "open",
  "investigating",
  "resolved",
  "ignored",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface CreateIssueInput {
  projectId: string;
  fingerprint: string;
  fingerprintSignature: string;
  type: IssueType;
  title: string;
  normalizedMessage: string;
  severity: IssueSeverity;
  firstSeenAt: Date;
  release: string | null;
}

export interface RecordIssueOccurrenceInput {
  issueId: string;
  occurredAt: Date;
  release: string | null;
  /** True when the event's telemetry session had no relation with the issue yet. */
  newSession: boolean;
  /** True when the issue was resolved and this occurrence reopens it. */
  reopenAsRegression: boolean;
}

/**
 * Locks the issue row for a (project, fingerprint) pair when it exists.
 * Callers must be inside a transaction: the row lock is what serializes
 * concurrent occurrences of the same fingerprint.
 */
export async function lockIssueByFingerprint(
  tx: DbTransaction,
  projectId: string,
  fingerprint: string,
): Promise<IssueRow | undefined> {
  const rows = await tx
    .select()
    .from(issues)
    .where(
      and(eq(issues.projectId, projectId), eq(issues.fingerprint, fingerprint)),
    )
    .limit(1)
    .for("update");
  return rows[0];
}

/**
 * Inserts a brand-new issue, tolerating a concurrent insert of the same
 * (project, fingerprint): `ON CONFLICT DO NOTHING` returns no row when another
 * transaction won the race, and the caller then locks the committed row.
 *
 * Counters start at zero and are incremented through `recordIssueOccurrence`,
 * so creation and repeated occurrences share exactly one aggregate code path.
 */
export async function insertIssueIfAbsent(
  tx: DbTransaction,
  input: CreateIssueInput,
): Promise<IssueRow | undefined> {
  const rows = await tx
    .insert(issues)
    .values({
      projectId: input.projectId,
      fingerprint: input.fingerprint,
      fingerprintSignature: input.fingerprintSignature,
      type: input.type,
      title: input.title,
      normalizedMessage: input.normalizedMessage,
      status: "open",
      severity: input.severity,
      assignedToUserId: null,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.firstSeenAt,
      resolvedAt: null,
      firstRelease: input.release,
      lastRelease: input.release,
      occurrenceCount: 0,
      affectedSessionCount: 0,
    })
    .onConflictDoNothing({
      target: [issues.projectId, issues.fingerprint],
    })
    .returning();
  return rows[0];
}

/**
 * Applies one occurrence to an existing issue:
 * - occurrence_count increments exactly once;
 * - affected_session_count increments only when the caller registered a new
 *   (issue, session) relation;
 * - first/last seen use LEAST/GREATEST so out-of-order events stay correct;
 * - first/last release follow the timestamps that defined first/last seen;
 * - a resolved issue reopens (status open, resolved_at null).
 *
 * All assignments read the pre-update row, which is how the release CASE
 * expressions compare against the previous extremes.
 */
export async function recordIssueOccurrence(
  tx: DbTransaction,
  input: RecordIssueOccurrenceInput,
): Promise<IssueRow | undefined> {
  const patch = {
    occurrenceCount: sql`${issues.occurrenceCount} + 1`,
    affectedSessionCount: input.newSession
      ? sql`${issues.affectedSessionCount} + 1`
      : sql`${issues.affectedSessionCount}`,
    firstSeenAt: sql`LEAST(${issues.firstSeenAt}, ${input.occurredAt})`,
    lastSeenAt: sql`GREATEST(${issues.lastSeenAt}, ${input.occurredAt})`,
    firstRelease: sql`CASE WHEN ${input.occurredAt} < ${issues.firstSeenAt} THEN ${input.release} ELSE ${issues.firstRelease} END`,
    lastRelease: sql`CASE WHEN ${input.occurredAt} > ${issues.lastSeenAt} THEN ${input.release} ELSE ${issues.lastRelease} END`,
    updatedAt: new Date(),
    ...(input.reopenAsRegression ? { status: "open", resolvedAt: null } : {}),
  };

  const rows = await tx
    .update(issues)
    .set(patch)
    .where(eq(issues.id, input.issueId))
    .returning();
  return rows[0];
}

/** Reads one issue by id (no lock). */
export async function findIssueById(
  db: DbOrTx,
  issueId: string,
): Promise<IssueRow | undefined> {
  const rows = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0];
}

/**
 * Locks one issue row by id. Callers must be inside a transaction: the row
 * lock serializes concurrent mutations (status, assignment) of one issue.
 */
export async function lockIssueById(
  tx: DbTransaction,
  issueId: string,
): Promise<IssueRow | undefined> {
  const rows = await tx
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .for("update");
  return rows[0];
}

export interface UpdateIssueRowPatch {
  status?: "open" | "investigating" | "resolved" | "ignored";
  assignedToUserId?: string | null;
  resolvedAt?: Date | null;
}

/**
 * Applies a field patch to one issue row and bumps updated_at.
 */
export async function updateIssueRow(
  tx: DbTransaction,
  issueId: string,
  patch: UpdateIssueRowPatch,
): Promise<IssueRow | undefined> {
  const rows = await tx
    .update(issues)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(issues.id, issueId))
    .returning();
  return rows[0];
}
