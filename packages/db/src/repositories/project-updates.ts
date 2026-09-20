import { sql } from "drizzle-orm";
import type { DbTransaction } from "./db-types.js";

/**
 * PostgreSQL NOTIFY channel used to announce successful issue changes.
 * Block 6 will subscribe to this channel to feed dashboard SSE. The payload
 * is intentionally tiny and contains no telemetry, messages or secrets.
 */
export const PROJECT_UPDATES_CHANNEL = "replaybug_project_updates";
export const PROJECT_UPDATE_VERSION = 1;

export type ProjectUpdateType =
  | "issue.created"
  | "issue.updated"
  | "issue.regressed"
  | "comment.created"
  | "assignment.changed"
  | "tags.changed"
  | "reproduction.ready"
  | "reproduction.failed"
  | "ai_analysis.ready"
  | "ai_analysis.failed";

export interface ProjectUpdateNotification {
  version: typeof PROJECT_UPDATE_VERSION;
  type: ProjectUpdateType;
  projectId: string;
  issueId: string;
  /**
   * Originating telemetry event when the update came from processing
   * (issue.created/regressed). Dashboard mutations (status, assignment,
   * tags, comments) carry no event and omit it.
   */
  eventId?: string;
  /**
   * Reproduction this update refers to. Only present on
   * reproduction.ready / reproduction.failed. Kept tiny: pg_notify
   * carries ids only, never code or secrets.
   */
  reproductionId?: string;
  /**
   * AI analysis this update refers to. Only present on
   * ai_analysis.ready / ai_analysis.failed. Kept tiny: pg_notify carries ids
   * only, never prompts, evidence, or model output.
   */
  analysisId?: string;
}

/**
 * Publishes one project update inside the caller's transaction. PostgreSQL
 * delivers the notification after commit, so subscribers never observe an
 * issue change that was rolled back.
 */
export async function notifyProjectIssueUpdate(
  tx: DbTransaction,
  payload: ProjectUpdateNotification,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_notify(${PROJECT_UPDATES_CHANNEL}, ${JSON.stringify(payload)})`,
  );
}
