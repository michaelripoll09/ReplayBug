import {
  StoredEventPayloadError,
  deriveEventProcessingPlan,
  insertIssueActivity,
  insertIssueIfAbsent,
  insertNotification,
  lockEventForProcessing,
  lockIssueByFingerprint,
  markEventProcessed,
  markEventRejected,
  notifyProjectIssueUpdate,
  recordIssueAffectedSession,
  recordIssueOccurrence,
} from "@replaybug/db";
import type {
  Database,
  DbTransaction,
  IssueRow,
  IssueSeverity,
  IssueType,
} from "@replaybug/db";

/**
 * Event processing service.
 *
 * Everything an issue occurrence changes — issue row, aggregates, event
 * association, activity, notification and the NOTIFY payload — commits in one
 * PostgreSQL transaction. The event row is locked first, so a redelivered job
 * for the same event observes `processed` and no-ops without touching
 * counters.
 */

export interface ProcessEventDeps {
  db: Database;
}

export type ProcessEventOutcome =
  | {
      status: "processed";
      projectId: string;
      issueId: string | null;
      fingerprint: string | null;
    }
  | { status: "already-processed"; projectId: string; issueId: string | null }
  | { status: "already-rejected"; projectId: string; reason: string | null }
  | { status: "rejected"; projectId: string; reason: string }
  | { status: "event-not-found" };

export async function processEvent(
  deps: ProcessEventDeps,
  eventId: string,
): Promise<ProcessEventOutcome> {
  return deps.db.transaction(async (tx): Promise<ProcessEventOutcome> => {
    const event = await lockEventForProcessing(tx, eventId);
    if (event === undefined) {
      // No row to process: the job refers to a deleted/unknown event. This is
      // terminal and safe to acknowledge without retrying.
      return { status: "event-not-found" };
    }
    if (event.processingState === "processed") {
      return {
        status: "already-processed",
        projectId: event.projectId,
        issueId: null,
      };
    }
    if (event.processingState === "rejected") {
      return {
        status: "already-rejected",
        projectId: event.projectId,
        reason: null,
      };
    }

    let plan;
    try {
      plan = deriveEventProcessingPlan({
        projectId: event.projectId,
        eventType: event.eventType,
        payload: event.payloadJson,
      });
    } catch (error) {
      if (error instanceof StoredEventPayloadError) {
        // Deterministic stored-event problem: reject once, never retry.
        await markEventRejected(tx, {
          eventId,
          rejectionReason: error.code,
        });
        return {
          status: "rejected",
          projectId: event.projectId,
          reason: error.code,
        };
      }
      throw error;
    }

    if (plan.kind === "non_issue") {
      // Recognized and acknowledged: pending -> processed without grouping.
      await markEventProcessed(tx, {
        eventId,
        fingerprint: null,
        issueId: null,
      });
      return {
        status: "processed",
        projectId: event.projectId,
        issueId: null,
        fingerprint: null,
      };
    }

    const descriptor = plan.descriptor;
    const issue = await lockOrCreateIssue(tx, event.projectId, {
      fingerprint: descriptor.fingerprint,
      fingerprintSignature: descriptor.signature,
      type: descriptor.type,
      title: descriptor.title,
      normalizedMessage: descriptor.normalizedMessage,
      severity: descriptor.severity,
      firstSeenAt: event.occurredAt,
      release: event.release,
    });

    const newSession = await recordIssueAffectedSession(tx, {
      issueId: issue.row.id,
      telemetrySessionId: event.telemetrySessionId,
      firstSeenAt: event.occurredAt,
    });

    const reopenAsRegression =
      !issue.created && issue.row.status === "resolved";
    await recordIssueOccurrence(tx, {
      issueId: issue.row.id,
      occurredAt: event.occurredAt,
      release: event.release,
      newSession,
      reopenAsRegression,
    });

    if (issue.created) {
      await insertIssueActivity(tx, {
        issueId: issue.row.id,
        actorUserId: null,
        type: "created",
        metadataJson: { eventId },
      });
    } else if (reopenAsRegression) {
      await insertIssueActivity(tx, {
        issueId: issue.row.id,
        actorUserId: null,
        type: "regression_detected",
        metadataJson: { eventId },
      });
      if (issue.row.assignedToUserId !== null) {
        await insertNotification(tx, {
          userId: issue.row.assignedToUserId,
          workspaceId: event.workspaceId,
          projectId: event.projectId,
          issueId: issue.row.id,
          type: "issue_regression",
          title: `Issue regressed: ${issue.row.title}`,
          body: "A new occurrence was detected after this issue was marked resolved.",
        });
      }
    }

    await markEventProcessed(tx, {
      eventId,
      fingerprint: descriptor.fingerprint,
      issueId: issue.row.id,
    });

    await notifyProjectIssueUpdate(tx, {
      version: 1,
      type: issue.created
        ? "issue.created"
        : reopenAsRegression
          ? "issue.regressed"
          : "issue.updated",
      projectId: event.projectId,
      issueId: issue.row.id,
      eventId,
    });

    return {
      status: "processed",
      projectId: event.projectId,
      issueId: issue.row.id,
      fingerprint: descriptor.fingerprint,
    };
  });
}

interface LockOrCreateResult {
  row: IssueRow;
  created: boolean;
}

interface IssueCandidateInput {
  fingerprint: string;
  fingerprintSignature: string;
  type: IssueType;
  title: string;
  normalizedMessage: string;
  severity: IssueSeverity;
  firstSeenAt: Date;
  release: string | null;
}

/**
 * Lock-or-create for one fingerprint:
 * 1. lock the existing issue row (serializes concurrent occurrences);
 * 2. otherwise insert with ON CONFLICT DO NOTHING;
 * 3. when a concurrent transaction won the insert, re-select the committed
 *    row (READ COMMITTED makes it visible to the new statement).
 */
async function lockOrCreateIssue(
  tx: DbTransaction,
  projectId: string,
  input: IssueCandidateInput,
): Promise<LockOrCreateResult> {
  const existing = await lockIssueByFingerprint(
    tx,
    projectId,
    input.fingerprint,
  );
  if (existing !== undefined) {
    return { row: existing, created: false };
  }

  const inserted = await insertIssueIfAbsent(tx, { projectId, ...input });
  if (inserted !== undefined) {
    return { row: inserted, created: true };
  }

  const raced = await lockIssueByFingerprint(tx, projectId, input.fingerprint);
  if (raced === undefined) {
    throw new Error(
      "issue upsert race: conflicting issue row is not visible; retrying",
    );
  }
  return { row: raced, created: false };
}
