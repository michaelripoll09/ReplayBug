import {
  IssueActivityRepo,
  IssueCommentRepo,
  IssueListRepo,
  IssueRepo,
  MembershipRepo,
  MetricsRepo,
  NotificationRepo,
  OccurrenceRepo,
  ProjectRepo,
  ProjectUpdatesRepo,
  TagRepo,
  UserRepo,
  type Database,
  type DbTransaction,
} from "@replaybug/db";
import type {
  ActivityListQuery,
  CommentListQuery,
  CreateCommentRequest,
  CreateTagRequest,
  EventDetail,
  IssueActivity,
  IssueComment,
  IssueListQuery,
  IssueSummary,
  IssueTag,
  MetricsQuery,
  Occurrence,
  OccurrenceListQuery,
  ProjectMetrics,
  UpdateCommentRequest,
  UpdateIssueAssigneeRequest,
  UpdateIssueStatusRequest,
  WorkspaceRole,
} from "@replaybug/contracts";
import {
  forbidden,
  internalError,
  notFound,
  validationError,
} from "../errors.js";
import type { Capability } from "../authz/policy.js";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import {
  toEventDetailDto,
  toIssueActivityDto,
  toIssueCommentDto,
  toIssueDto,
  toIssueTagDto,
  toOccurrenceDto,
} from "./dto.js";

export async function membershipOrThrow(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const m = await MembershipRepo.findMembership(db, workspaceId, userId);
  return requireWorkspaceMembership(
    m === undefined
      ? undefined
      : {
          workspaceId: m.workspaceId,
          userId: m.userId,
          role: m.role as WorkspaceRole,
        },
  );
}

/**
 * Project-scoped issue list. Authz: project must belong to the caller's
 * workspace (else NOT_FOUND anti-enumeration) and the caller needs
 * `issue:read`. Tags and assignees are batch-loaded (no N+1); the DTO
 * carries no payload_json or fingerprint material.
 */
export async function listIssues(
  db: Database,
  userId: string,
  projectId: string,
  query: IssueListQuery,
): Promise<{ items: IssueSummary[]; nextCursor?: string }> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
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
  requireWorkspaceCapability(membership, "issue:read");

  let cursor: IssueListRepo.IssueListCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = IssueListRepo.decodeIssueCursor(
      query.sort,
      query.order,
      query.cursor,
    );
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }

  const result = await IssueListRepo.listIssues(db, {
    projectId,
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.environment !== undefined
      ? { environment: query.environment }
      : {}),
    ...(query.release !== undefined ? { release: query.release } : {}),
    ...(query.type !== undefined ? { type: query.type } : {}),
    ...(query.assigneeId !== undefined ? { assigneeId: query.assigneeId } : {}),
    ...(query.unassigned === true ? { unassigned: true as const } : {}),
    ...(query.tag !== undefined ? { tag: query.tag } : {}),
    ...(query.since !== undefined ? { since: new Date(query.since) } : {}),
    ...(query.until !== undefined ? { until: new Date(query.until) } : {}),
    ...(query.q !== undefined ? { q: query.q } : {}),
    sort: query.sort,
    order: query.order,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });

  const issueIds = result.rows.map((r) => r.id);
  const [tagsByIssue, usersById] = await Promise.all([
    TagRepo.listTagsForIssues(db, issueIds),
    UserRepo.findUsersByIds(
      db,
      result.rows
        .map((r) => r.assignedToUserId)
        .filter((id): id is string => id !== null),
    ),
  ]);

  const items = result.rows.map((row) =>
    toIssueDto(
      row,
      row.assignedToUserId === null
        ? null
        : (usersById.get(row.assignedToUserId) ?? null),
      tagsByIssue.get(row.id) ?? [],
    ),
  );
  return result.nextCursor === null
    ? { items }
    : { items, nextCursor: result.nextCursor };
}

const METRICS_RANGE_MS = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
} as const;
/**
 * Diagnosis-focused project metrics. Authz mirrors the issue list
 * (`issue:read`): viewers may read metrics, and cross-workspace projects
 * stay NOT_FOUND. Buckets are UTC; <=48h ranges bucket hourly, else daily.
 */
export async function getProjectMetrics(
  db: Database,
  userId: string,
  projectId: string,
  query: MetricsQuery,
): Promise<ProjectMetrics> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
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
  requireWorkspaceCapability(membership, "issue:read");

  const end = new Date();
  const start = new Date(end.getTime() - METRICS_RANGE_MS[query.range]);
  const bucket: MetricsRepo.MetricsBucketSize =
    query.range === "24h" ? "hour" : "day";
  const bucketCount =
    query.range === "24h" ? 24 : query.range === "7d" ? 7 : 30;

  const metrics = await MetricsRepo.getProjectMetrics(db, {
    projectId,
    start,
    end,
    bucket,
    bucketCount,
  });

  return {
    range: query.range,
    bucketStart: start.toISOString(),
    bucketEnd: end.toISOString(),
    bucketSize: bucket === "hour" ? "hourly" : "daily",
    unresolvedCount: metrics.unresolvedCount,
    newIssueCount: metrics.newIssueCount,
    occurrenceCount: metrics.occurrenceCount,
    affectedSessionCount: metrics.affectedSessionCount,
    regressionCount: metrics.regressionCount,
    topIssues: metrics.topIssues.map((t) => ({
      issueId: t.issueId,
      title: t.title,
      occurrences: t.occurrences,
    })),
    overTime: metrics.overTime.map((b) => ({
      bucketStart: b.bucketStart.toISOString(),
      occurrences: b.occurrences,
      newIssues: b.newIssues,
    })),
    byEnvironment: metrics.byEnvironment,
    byRelease: metrics.byRelease,
  };
}

async function issueWithAccess(
  db: Database,
  userId: string,
  issueId: string,
  capability: Capability = "issue:read",
): Promise<{
  issue: NonNullable<Awaited<ReturnType<typeof IssueRepo.findIssueById>>>;
  membership: { workspaceId: string; userId: string; role: WorkspaceRole };
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

export async function projectWithAccess(
  db: Database,
  userId: string,
  projectId: string,
  capability: Capability,
): Promise<{
  project: NonNullable<Awaited<ReturnType<typeof ProjectRepo.findProjectById>>>;
  membership: { workspaceId: string; userId: string; role: WorkspaceRole };
}> {
  const project = await ProjectRepo.findProjectById(db, projectId);
  if (project === undefined) {
    throw notFound("Project");
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
  return { project, membership };
}

/** Issue DTO with batch-loaded assignee + tags (no N+1). */
async function issueDto(
  db: Database,
  row: IssueRepo.IssueRow,
): Promise<IssueSummary> {
  const [tags, usersById] = await Promise.all([
    TagRepo.listTagsForIssue(db, row.id),
    row.assignedToUserId === null
      ? Promise.resolve(new Map())
      : UserRepo.findUsersByIds(db, [row.assignedToUserId]),
  ]);
  return toIssueDto(
    row,
    row.assignedToUserId === null
      ? null
      : (usersById.get(row.assignedToUserId) ?? null),
    tags,
  );
}

/**
 * Issue detail: same DTO as the list (tags + assignee embedded, no
 * payloads or fingerprint material). Cross-workspace issues read as
 * NOT_FOUND (anti-enumeration).
 */
export async function getIssueById(
  db: Database,
  userId: string,
  issueId: string,
): Promise<IssueSummary> {
  const { issue } = await issueWithAccess(db, userId, issueId);
  return issueDto(db, issue);
}

/**
 * Issue occurrences newest-first with bounded keyset pagination. Items
 * carry envelope metadata only; full payloads require the event endpoint.
 */
export async function listIssueOccurrences(
  db: Database,
  userId: string,
  issueId: string,
  query: OccurrenceListQuery,
): Promise<{ items: Occurrence[]; nextCursor?: string }> {
  const { issue } = await issueWithAccess(db, userId, issueId);
  let cursor: OccurrenceRepo.OccurrenceCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = OccurrenceRepo.decodeOccurrenceCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await OccurrenceRepo.listIssueOccurrences(db, {
    issueId: issue.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  return result.nextCursor === null
    ? { items: result.rows.map(toOccurrenceDto) }
    : {
        items: result.rows.map(toOccurrenceDto),
        nextCursor: result.nextCursor,
      };
}

/**
 * Sanitized event detail with explicit per-type evidence. Authz follows the
 * event's project (anti-enumeration); unknown stored types degrade to the
 * SDK shape rather than leaking raw payloads.
 */
export async function getEventById(
  db: Database,
  userId: string,
  eventId: string,
): Promise<EventDetail> {
  const event = await OccurrenceRepo.findEventById(db, eventId);
  if (event === undefined) {
    throw notFound("Event");
  }
  const project = await ProjectRepo.findProjectById(db, event.projectId);
  if (project === undefined) {
    throw notFound("Event");
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
  requireWorkspaceCapability(membership, "issue:read");
  return toEventDetailDto(event);
}

async function notifyIssue(
  tx: DbTransaction,
  type:
    "issue.updated" | "comment.created" | "assignment.changed" | "tags.changed",
  projectId: string,
  issueId: string,
): Promise<void> {
  await ProjectUpdatesRepo.notifyProjectIssueUpdate(tx, {
    version: ProjectUpdatesRepo.PROJECT_UPDATE_VERSION,
    type,
    projectId,
    issueId,
  });
}

/**
 * Status transition with lifecycle rules: `resolved` stamps resolved_at,
 * every other status clears it. Idempotent: repeating the current status
 * returns the DTO with no new activity and no notification. The row lock
 * serializes concurrent transitions; activity + pg_notify commit atomically.
 */
export async function updateIssueStatus(
  db: Database,
  userId: string,
  issueId: string,
  input: UpdateIssueStatusRequest,
): Promise<IssueSummary> {
  const { issue } = await issueWithAccess(
    db,
    userId,
    issueId,
    "issue:update-status",
  );
  if (issue.status === input.status) {
    return issueDto(db, issue);
  }
  const updated = await db.transaction(async (tx) => {
    const locked = await IssueRepo.lockIssueById(tx, issueId);
    if (locked === undefined) {
      throw notFound("Issue");
    }
    if (locked.status === input.status) {
      return locked;
    }
    const row = await IssueRepo.updateIssueRow(tx, issueId, {
      status: input.status,
      resolvedAt: input.status === "resolved" ? new Date() : null,
    });
    if (row === undefined) {
      throw notFound("Issue");
    }
    await IssueActivityRepo.insertIssueActivity(tx, {
      issueId,
      actorUserId: userId,
      type: "status_changed",
      metadataJson: { from: locked.status, to: input.status },
    });
    await notifyIssue(tx, "issue.updated", row.projectId, issueId);
    return row;
  });
  return issueDto(db, updated);
}

/**
 * Assignment with workspace-membership check: the assignee must belong to
 * the issue's workspace, else 403 (never 404, so user existence and
 * membership are not enumerable). Unchanged assignments are no-ops. A new
 * assignee gets an `issue_assigned` notification unless they assigned the
 * issue to themselves.
 */
export async function updateIssueAssignee(
  db: Database,
  actorUserId: string,
  issueId: string,
  input: UpdateIssueAssigneeRequest,
): Promise<IssueSummary> {
  const { issue, membership } = await issueWithAccess(
    db,
    actorUserId,
    issueId,
    "issue:assign",
  );
  if (input.userId !== null) {
    const assignee = await MembershipRepo.findMembership(
      db,
      membership.workspaceId,
      input.userId,
    );
    if (assignee === undefined) {
      throw forbidden("Assignee must be a workspace member");
    }
  }
  if (issue.assignedToUserId === input.userId) {
    return issueDto(db, issue);
  }
  const updated = await db.transaction(async (tx) => {
    const locked = await IssueRepo.lockIssueById(tx, issueId);
    if (locked === undefined) {
      throw notFound("Issue");
    }
    if (locked.assignedToUserId === input.userId) {
      return locked;
    }
    const row = await IssueRepo.updateIssueRow(tx, issueId, {
      assignedToUserId: input.userId,
    });
    if (row === undefined) {
      throw notFound("Issue");
    }
    if (input.userId === null) {
      await IssueActivityRepo.insertIssueActivity(tx, {
        issueId,
        actorUserId,
        type: "unassigned",
        metadataJson: {},
      });
    } else {
      await IssueActivityRepo.insertIssueActivity(tx, {
        issueId,
        actorUserId,
        type: "assigned",
        metadataJson: { userId: input.userId },
      });
      if (input.userId !== actorUserId) {
        await NotificationRepo.insertNotification(tx, {
          userId: input.userId,
          workspaceId: membership.workspaceId,
          projectId: row.projectId,
          issueId,
          type: "issue_assigned",
          title: `Assigned: ${row.title}`,
          body: `You were assigned to "${row.title}".`,
        });
      }
    }
    await notifyIssue(tx, "assignment.changed", row.projectId, issueId);
    return row;
  });
  return issueDto(db, updated);
}

/** Project tag listing (alphabetical, stable). */
export async function listProjectTags(
  db: Database,
  userId: string,
  projectId: string,
): Promise<IssueTag[]> {
  const { project } = await projectWithAccess(
    db,
    userId,
    projectId,
    "issue:read",
  );
  const rows = await TagRepo.listTagsByProject(db, project.id);
  return rows.map(toIssueTagDto);
}

/**
 * Project-local tag creation. Idempotent: an existing slug returns the
 * current row instead of conflicting.
 */
export async function createProjectTag(
  db: Database,
  userId: string,
  projectId: string,
  input: CreateTagRequest,
): Promise<{ tag: IssueTag; created: boolean }> {
  const { project } = await projectWithAccess(
    db,
    userId,
    projectId,
    "issue:manage-tags",
  );
  const name = input.name.trim();
  const slug = TagRepo.normalizeTagSlug(name);
  if (slug === "") {
    throw validationError("Tag name must contain letters or digits");
  }
  const result = await db.transaction(async (tx) => {
    const inserted = await TagRepo.insertTagIfAbsent(tx, {
      projectId: project.id,
      name,
    });
    if (inserted !== undefined) {
      return { row: inserted, created: true };
    }
    const existing = await TagRepo.findTagBySlug(tx, project.id, slug);
    if (existing === undefined) {
      throw internalError("Tag creation raced and left no row");
    }
    return { row: existing, created: false };
  });
  return { tag: toIssueTagDto(result.row), created: result.created };
}

/**
 * Assigns a project-local tag to an issue. Cross-project tag ids read as
 * NOT_FOUND. Idempotent: re-assigning notifies nobody and changes nothing.
 */
export async function assignIssueTag(
  db: Database,
  userId: string,
  issueId: string,
  tagId: string,
): Promise<IssueTag> {
  const { issue } = await issueWithAccess(
    db,
    userId,
    issueId,
    "issue:manage-tags",
  );
  const tag = await TagRepo.findTagById(db, tagId);
  if (tag === undefined || tag.projectId !== issue.projectId) {
    throw notFound("Tag");
  }
  await db.transaction(async (tx) => {
    const added = await TagRepo.assignTagToIssue(tx, issueId, tag.id);
    if (added) {
      await notifyIssue(tx, "tags.changed", issue.projectId, issueId);
    }
  });
  return toIssueTagDto(tag);
}

/** Removes a tag from an issue. Idempotent: absent links report removed:false. */
export async function unassignIssueTag(
  db: Database,
  userId: string,
  issueId: string,
  tagId: string,
): Promise<{ removed: boolean }> {
  const { issue } = await issueWithAccess(
    db,
    userId,
    issueId,
    "issue:manage-tags",
  );
  const tag = await TagRepo.findTagById(db, tagId);
  if (tag === undefined || tag.projectId !== issue.projectId) {
    throw notFound("Tag");
  }
  const removed = await db.transaction(async (tx) => {
    const deleted = await TagRepo.unassignTagFromIssue(tx, issueId, tag.id);
    if (deleted) {
      await notifyIssue(tx, "tags.changed", issue.projectId, issueId);
    }
    return deleted;
  });
  return { removed };
}

/** Issue comments oldest-first with bounded keyset pagination. */
export async function listIssueComments(
  db: Database,
  userId: string,
  issueId: string,
  query: CommentListQuery,
): Promise<{ items: IssueComment[]; nextCursor?: string }> {
  const { issue } = await issueWithAccess(db, userId, issueId);
  let cursor: IssueCommentRepo.CommentCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = IssueCommentRepo.decodeCommentCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await IssueCommentRepo.listCommentsPaged(db, {
    issueId: issue.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const authors = await UserRepo.findUsersByIds(
    db,
    result.rows
      .map((r) => r.authorUserId)
      .filter((id): id is string => id !== null),
  );
  const items = result.rows.map((row) =>
    toIssueCommentDto(
      row,
      row.authorUserId === null
        ? null
        : (authors.get(row.authorUserId) ?? null),
    ),
  );
  return result.nextCursor === null
    ? { items }
    : { items, nextCursor: result.nextCursor };
}

/**
 * Comment creation: insert + `comment_added` activity + pg_notify commit
 * atomically. The activity references the comment id; the body is never
 * stored in activity metadata.
 */
export async function createIssueComment(
  db: Database,
  userId: string,
  issueId: string,
  input: CreateCommentRequest,
): Promise<IssueComment> {
  const { issue } = await issueWithAccess(db, userId, issueId, "issue:comment");
  const created = await db.transaction(async (tx) => {
    const row = await IssueCommentRepo.insertIssueComment(tx, {
      issueId: issue.id,
      authorUserId: userId,
      bodyMarkdown: input.body,
    });
    if (row === undefined) {
      throw internalError("Comment insert returned no row");
    }
    await IssueActivityRepo.insertIssueActivity(tx, {
      issueId: issue.id,
      actorUserId: userId,
      type: "comment_added",
      metadataJson: { commentId: row.id },
    });
    await notifyIssue(tx, "comment.created", issue.projectId, issue.id);
    return row;
  });
  const authors = await UserRepo.findUsersByIds(db, [userId]);
  const author = authors.get(userId);
  if (author === undefined) {
    throw internalError("Comment author has no user row");
  }
  return toIssueCommentDto(created, author);
}

/**
 * Own-comment edit: only the author may change the body (403 otherwise).
 * No activity row and no notification: edits are silent corrections.
 */
export async function updateIssueComment(
  db: Database,
  userId: string,
  issueId: string,
  commentId: string,
  input: UpdateCommentRequest,
): Promise<IssueComment> {
  const { issue } = await issueWithAccess(db, userId, issueId, "issue:comment");
  const comment = await IssueCommentRepo.findCommentById(db, commentId);
  if (comment === undefined || comment.issueId !== issue.id) {
    throw notFound("Comment");
  }
  if (comment.authorUserId !== userId) {
    throw forbidden("Only the comment author can edit it");
  }
  const updated = await db.transaction(async (tx) => {
    const row = await IssueCommentRepo.updateCommentBody(
      tx,
      commentId,
      input.body,
    );
    if (row === undefined) {
      throw notFound("Comment");
    }
    return row;
  });
  const authors = await UserRepo.findUsersByIds(db, [userId]);
  const author = authors.get(userId);
  if (author === undefined) {
    throw internalError("Comment author has no user row");
  }
  return toIssueCommentDto(updated, author);
}

/**
 * Issue activity timeline newest-first with bounded keyset pagination.
 * Actor summaries batch-load; metadata stays minimal and safe (it never
 * carries comment bodies or payloads — enforced at write time in T08).
 */
export async function listIssueActivity(
  db: Database,
  userId: string,
  issueId: string,
  query: ActivityListQuery,
): Promise<{ items: IssueActivity[]; nextCursor?: string }> {
  const { issue } = await issueWithAccess(db, userId, issueId);
  let cursor: IssueActivityRepo.ActivityCursor | undefined;
  if (query.cursor !== undefined) {
    const decoded = IssueActivityRepo.decodeActivityCursor(query.cursor);
    if (decoded === null) {
      throw validationError("Invalid pagination cursor");
    }
    cursor = decoded;
  }
  const result = await IssueActivityRepo.listIssueActivityPaged(db, {
    issueId: issue.id,
    limit: query.limit,
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const actors = await UserRepo.findUsersByIds(
    db,
    result.rows
      .map((r) => r.actorUserId)
      .filter((id): id is string => id !== null),
  );
  const items = result.rows.map((row) =>
    toIssueActivityDto(
      row,
      row.actorUserId === null ? null : (actors.get(row.actorUserId) ?? null),
    ),
  );
  return result.nextCursor === null
    ? { items }
    : { items, nextCursor: result.nextCursor };
}
