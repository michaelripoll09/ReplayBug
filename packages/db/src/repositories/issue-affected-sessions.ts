import { issueAffectedSessions } from "../schema.js";
import type { DbTransaction } from "./db-types.js";

export type IssueAffectedSessionRow = typeof issueAffectedSessions.$inferSelect;

export interface RecordIssueAffectedSessionInput {
  issueId: string;
  telemetrySessionId: string;
  firstSeenAt: Date;
}

/**
 * Registers that an issue affected a telemetry session.
 *
 * Returns true only when a new (issue, session) relation was actually
 * inserted. The composite primary key plus `ON CONFLICT DO NOTHING` is what
 * makes `issues.affected_session_count` a correct distinct-session count
 * under concurrency: callers increment the counter exactly when this returns
 * true, so two simultaneous events of the same session cannot double-count.
 */
export async function recordIssueAffectedSession(
  tx: DbTransaction,
  input: RecordIssueAffectedSessionInput,
): Promise<boolean> {
  const rows = await tx
    .insert(issueAffectedSessions)
    .values({
      issueId: input.issueId,
      telemetrySessionId: input.telemetrySessionId,
      firstSeenAt: input.firstSeenAt,
    })
    .onConflictDoNothing({
      target: [
        issueAffectedSessions.issueId,
        issueAffectedSessions.telemetrySessionId,
      ],
    })
    .returning({ issueId: issueAffectedSessions.issueId });
  return rows.length > 0;
}
