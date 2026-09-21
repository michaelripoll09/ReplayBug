import {
  ArtifactStorageError,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import {
  StoredEventPayloadError,
  deriveEventProcessingPlan,
  getEventForSymbolication,
  insertIssueActivity,
  insertIssueIfAbsent,
  insertNotification,
  lockEventForProcessing,
  lockIssueByFingerprint,
  markEventProcessed,
  markEventRejected,
  notifyProjectIssueUpdate,
  persistEventSymbolication,
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
import { symbolicateEvent } from "../symbolication/symbolicate.js";
import { selectMappedFingerprintFrames } from "../symbolication/fingerprint-frames.js";

/**
 * Event processing service.
 *
 * RS-09 pipeline order (source-mapped fingerprinting):
 * (A) preload the immutable event/release context outside any transaction;
 * (B) resolve artifacts + symbolicate OUTSIDE the issue transaction (never
 *     hold `SELECT ... FOR UPDATE` during file I/O);
 * (C) begin tx → lock the event FOR UPDATE → no-op when already
 *     processed/rejected (the precomputed symbolication is discarded, never
 *     re-applied);
 * (F) persist the precomputed symbolication as JSONB enrichment alongside
 *     the untouched public-ingest payload (raw frames are echoed inside the
 *     enrichment, never overwritten) → grouping/aggregates/NOTIFY → commit.
 *
 * RS-09 canonical fingerprint rule: an explicit developer fingerprint
 * (Block 5 custom grouping) always wins; otherwise, when at least one
 * useful mapped in-application frame exists, the fingerprint derives from
 * the mapped frames (original `src/...` location, per-position raw fallback
 * only where needed, deterministic, release excluded); with no useful
 * mapped frame the raw sanitized stack path runs exactly as before.
 *
 * Everything an issue occurrence changes — enrichment, issue row,
 * aggregates, event association, activity, notification and the NOTIFY
 * payload — still commits in one PostgreSQL transaction. Block 5
 * idempotency/concurrency guarantees are preserved: a redelivered job for
 * the same event observes `processed` and no-ops without touching counters.
 */

export interface ProcessEventDeps {
  db: Database;
  /**
   * Artifact blob store for symbolication. Optional so pre-storage callers
   * (and misconfigured workers) degrade instead of crashing: when absent,
   * symbolication reports `storage_unavailable` and processing continues
   * raw. Production wires `LocalArtifactStorage.fromEnv()`.
   */
  storage?: Pick<ArtifactStorage, "get"> | undefined;
}

/**
 * Fallback when no storage is configured: every blob read fails with a
 * storage error, which the symbolication layer maps to
 * `storage_unavailable` (raw processing, cause reflected, no poison).
 */
const UNAVAILABLE_STORAGE: Pick<ArtifactStorage, "get"> = {
  async get(): Promise<never> {
    throw new ArtifactStorageError("Artifact storage is not configured");
  },
};

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
  // (A) Preload immutable context: no row lock is held here.
  const preloaded = await getEventForSymbolication(deps.db, eventId);
  if (preloaded === undefined) {
    // No row to process: the job refers to a deleted/unknown event. This is
    // terminal and safe to acknowledge without retrying.
    return { status: "event-not-found" };
  }

  // (B) Resolve artifacts + symbolicate with no transaction held. Transient
  // DB failures throw (pg-boss retries); missing/invalid/unavailable maps
  // degrade to a cause status inside the result — never a throw.
  const symbolication = await symbolicateEvent(
    { db: deps.db, storage: deps.storage ?? UNAVAILABLE_STORAGE },
    {
      projectId: preloaded.projectId,
      release: preloaded.release,
      payload: preloaded.payloadJson,
    },
  );
  // Plain JSONB object: status + frames only, never storage keys (the
  // symbolication layer never includes them).
  const enrichment: Record<string, unknown> = {
    status: symbolication.status,
    rawFrames: symbolication.rawFrames,
    mappedFrames: symbolication.mappedFrames,
    mappedFrameCount: symbolication.mappedFrameCount,
  };

  // (C…F) Issue transaction: lock first, then persist + group + notify.
  return deps.db.transaction(async (tx): Promise<ProcessEventOutcome> => {
    const event = await lockEventForProcessing(tx, eventId);
    if (event === undefined) {
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
      // RS-09: mapped in-app frames win when useful ones exist; custom
      // fingerprints still override inside the derivation; otherwise the
      // raw sanitized stack path runs exactly as before (null → raw).
      plan = deriveEventProcessingPlan({
        projectId: event.projectId,
        eventType: event.eventType,
        payload: event.payloadJson,
        mappedFrames: selectMappedFingerprintFrames(symbolication) ?? undefined,
      });
    } catch (error) {
      if (error instanceof StoredEventPayloadError) {
        // (F) Deterministic stored-event problem: persist the precomputed
        // enrichment, then reject once, never retry.
        await persistEventSymbolication(tx, {
          eventId,
          symbolication: enrichment,
        });
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
      // (F) Recognized and acknowledged: persist enrichment, then
      // pending -> processed without grouping.
      await persistEventSymbolication(tx, {
        eventId,
        symbolication: enrichment,
      });
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

    // (F) Persist the precomputed enrichment beside the association: the
    // ingest payload is immutable, raw frames live on inside the
    // enrichment, and grouping above used the RS-09 mapped/raw selection.
    await persistEventSymbolication(tx, {
      eventId,
      symbolication: enrichment,
    });
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
