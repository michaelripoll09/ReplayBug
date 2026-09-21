import { createHash } from "node:crypto";
import {
  AiAnalysisRepo,
  IssueActivityRepo,
  IssueRepo,
  MembershipRepo,
  OccurrenceRepo,
  ProjectRepo,
  UserRepo,
  type Database,
  type DbClient,
} from "@replaybug/db";
import {
  AI_ANALYSIS_VERSION,
  type AiAnalysisListQuery,
} from "@replaybug/contracts";
import type { ApiConfig } from "../config.js";
import {
  aiAnalysisNotConfigured,
  notFound,
  validationError,
} from "../errors.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import type { Capability } from "../authz/policy.js";
import { toAiAnalysisDetailDto, toAiAnalysisSummaryDto } from "./dto.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

interface RequestAiAnalysisDeps {
  db: Database;
  config: Pick<ApiConfig, "aiAnalysis">;
}

export interface RequestAiAnalysisResult {
  id: string;
  issueId: string;
  eventId: string;
  status: "pending";
  deduplicated: boolean;
}

export interface AiAnalysisSummaryItem {
  id: string;
  eventId: string | null;
  model: string;
  status: "pending" | "ready" | "failed";
  analysisVersion: string;
  requestedBy: { id: string; email: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AiAnalysisDetail {
  id: string;
  issueId: string;
  eventId: string | null;
  model: string;
  status: "pending" | "ready" | "failed";
  analysisVersion: string;
  requestedBy: { id: string; email: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
  summary: string | null;
  suspectedCause: string | null;
  evidence: Array<{ ref: string; reason: string }> | null;
  reproductionSteps: string[] | null;
  limitations: string[] | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function sha256IdempotencyKey(key: string): string {
  if (key.length === 0) {
    throw validationError("Idempotency key must not be empty");
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validationError("Idempotency key exceeds 256 characters");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
}> {
  const m = await MembershipRepo.findMembership(db, workspaceId, userId);
  return requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as "owner" | "admin" | "member" | "viewer",
        },
  );
}

async function issueWithAccess(
  db: Database,
  userId: string,
  issueId: string,
  capability: Capability,
): Promise<{
  issue: NonNullable<Awaited<ReturnType<typeof IssueRepo.findIssueById>>>;
  membership: {
    workspaceId: string;
    userId: string;
    role: "owner" | "admin" | "member" | "viewer";
  };
}> {
  const issue = await IssueRepo.findIssueById(db, issueId);
  if (issue === undefined) {
    throw notFound("Issue");
  }
  const project = await ProjectRepo.findProjectById(db, issue.projectId);
  if (project === undefined) {
    throw notFound("Issue");
  }
  const membership = await membershipOrThrow(db, project.workspaceId, userId);
  requireProjectAccess(
    {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    },
    { id: project.id, workspaceId: project.workspaceId },
  );
  requireWorkspaceCapability(membership, capability);
  return { issue, membership };
}

export async function requestAiAnalysis(
  deps: RequestAiAnalysisDeps,
  userId: string,
  eventId: string,
  idempotencyKey: string,
): Promise<RequestAiAnalysisResult> {
  if (deps.config.aiAnalysis.status !== "configured") {
    throw aiAnalysisNotConfigured();
  }
  const hash = sha256IdempotencyKey(idempotencyKey);

  const event = await OccurrenceRepo.findEventById(deps.db, eventId);
  if (event === undefined) {
    throw notFound("Event");
  }
  const project = await ProjectRepo.findProjectById(deps.db, event.projectId);
  if (project === undefined) {
    throw notFound("Event");
  }
  const membership = await membershipOrThrow(
    deps.db,
    project.workspaceId,
    userId,
  );
  requireProjectAccess(
    {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    },
    { id: project.id, workspaceId: project.workspaceId },
  );
  requireWorkspaceCapability(membership, "ai-analysis:request");

  if (event.issueId === null) {
    throw notFound("Event");
  }
  const issue = await IssueRepo.findIssueById(deps.db, event.issueId);
  if (issue === undefined || issue.projectId !== project.id) {
    throw notFound("Event");
  }

  const model = deps.config.aiAnalysis.model ?? "unknown";

  const result = await deps.db.transaction(async (tx) => {
    const created = await AiAnalysisRepo.createAiAnalysisRequest(tx, {
      issueId: issue.id,
      eventId: event.id,
      requestedByUserId: userId,
      model,
      analysisVersion: AI_ANALYSIS_VERSION,
      idempotencyKeyHash: hash,
    });
    if (created.created) {
      await IssueActivityRepo.insertIssueActivity(tx, {
        issueId: issue.id,
        actorUserId: userId,
        type: "ai_analysis_requested",
        metadataJson: {
          analysisId: created.row.id,
          eventId: event.id,
          model,
          analysisVersion: AI_ANALYSIS_VERSION,
        },
      });
    }
    return created;
  });

  return {
    id: result.row.id,
    issueId: result.row.issueId,
    eventId: result.row.eventId ?? eventId,
    status: "pending",
    deduplicated: !result.created,
  };
}

export async function listIssueAiAnalyses(
  db: Database,
  userId: string,
  issueId: string,
  query: AiAnalysisListQuery,
): Promise<{ items: AiAnalysisSummaryItem[]; nextCursor?: string }> {
  const { issue } = await issueWithAccess(
    db,
    userId,
    issueId,
    "ai-analysis:read",
  );

  let cursor: AiAnalysisRepo.AiAnalysisCursor | undefined = undefined;
  if (query.cursor !== undefined) {
    const decoded = AiAnalysisRepo.decodeAiAnalysisCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }

  const result = await AiAnalysisRepo.listIssueAiAnalyses(db, {
    issueId: issue.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });

  const userIds = result.rows
    .map((row) => row.requestedByUserId)
    .filter((id): id is string => id !== null);
  const usersById = await UserRepo.findUsersByIds(db, userIds);

  const items = result.rows.map((row) => {
    const userRow =
      row.requestedByUserId === null
        ? undefined
        : usersById.get(row.requestedByUserId);
    return toAiAnalysisSummaryDto(row, userRow);
  });

  return result.nextCursor === null
    ? { items }
    : { items, nextCursor: result.nextCursor };
}

export async function getAiAnalysisById(
  dbClient: DbClient,
  userId: string,
  analysisId: string,
): Promise<AiAnalysisDetail> {
  const row = await dbClient.db.query.aiAnalyses.findFirst({
    where: (table, { eq }) => eq(table.id, analysisId),
  });
  if (row === undefined) {
    throw notFound("Analysis");
  }
  const issue = await IssueRepo.findIssueById(dbClient.db, row.issueId);
  if (issue === undefined) {
    throw notFound("Analysis");
  }
  const project = await ProjectRepo.findProjectById(
    dbClient.db,
    issue.projectId,
  );
  if (project === undefined) {
    throw notFound("Analysis");
  }
  const membership = await membershipOrThrow(
    dbClient.db,
    project.workspaceId,
    userId,
  );
  requireProjectAccess(
    {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      role: membership.role,
    },
    { id: project.id, workspaceId: project.workspaceId },
  );
  requireWorkspaceCapability(membership, "ai-analysis:read");

  const userRow =
    row.requestedByUserId === null
      ? undefined
      : (
          await UserRepo.findUsersByIds(dbClient.db, [row.requestedByUserId])
        ).get(row.requestedByUserId);
  return toAiAnalysisDetailDto(row, userRow);
}
