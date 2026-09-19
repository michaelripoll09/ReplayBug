import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  pgEnum,
} from "drizzle-orm/pg-core";

/**
 * Better Auth persistence tables (official adapter shape).
 * Application code never creates a parallel users table: every FK that
 * needs an auth identity references `user.id` directly.
 */
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Top-level tenant. Slug is globally unique (documented): it is used in
 * URLs and must never collide across workspaces.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workspaces_created_by_idx").on(t.createdByUserId),
    index("workspaces_slug_idx").on(t.slug),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_memberships_workspace_user_unique").on(
      t.workspaceId,
      t.userId,
    ),
    index("workspace_memberships_workspace_idx").on(t.workspaceId),
    index("workspace_memberships_user_idx").on(t.userId),
    check(
      "workspace_memberships_role_check",
      sql`${t.role} IN ('owner','admin','member','viewer')`,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    timezone: text("timezone").notNull().default("UTC"),
    retentionDays: integer("retention_days").notNull().default(30),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("projects_workspace_slug_unique").on(t.workspaceId, t.slug),
    index("projects_workspace_idx").on(t.workspaceId),
    check(
      "projects_retention_check",
      sql`${t.retentionDays} >= 7 AND ${t.retentionDays} <= 365`,
    ),
  ],
);

export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("project_environments_project_name_unique").on(t.projectId, t.name),
    index("project_environments_project_idx").on(t.projectId),
    uniqueIndex("project_environments_single_default_unique")
      .on(t.projectId)
      .where(sql`${t.isDefault} = true`),
  ],
);

export const projectOrigins = pgTable(
  "project_origins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    origin: text("origin").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("project_origins_project_origin_unique").on(t.projectId, t.origin),
    index("project_origins_project_idx").on(t.projectId),
  ],
);

export const projectKeys = pgTable(
  "project_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().unique(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("project_keys_prefix_idx").on(t.prefix),
    index("project_keys_project_idx").on(t.projectId),
    index("project_keys_project_active_idx").on(t.projectId, t.revokedAt),
    check(
      "project_keys_kind_check",
      sql`${t.kind} IN ('public_ingest','secret')`,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    metadataJson: jsonb("metadata_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("audit_logs_project_created_idx").on(t.projectId, t.createdAt),
    check(
      "audit_logs_action_check",
      sql`${t.action} IN ('workspace.created','workspace.updated','project.created','project.updated','project.deleted','project_origin.created','project_origin.updated','project_origin.deleted','project_key.rotated')`,
    ),
  ],
);

/**
 * RS-04 releases: one addressable source-map upload target per
 * (project, version). `version` is intentionally NOT semver-restricted
 * (`web@1.4.2`, `demo@2026.09.18`, `1.4.2` are all valid): 1..128 chars
 * with no control characters. `commit_sha` is an optional hex git SHA
 * (7..64 chars); `repository_url` is an optional http/https shape that is
 * never fetched (no SSRF surface). Identity metadata is immutable: the
 * repository returns the existing row on identical re-create and raises a
 * version conflict on any metadata difference.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    commitSha: text("commit_sha"),
    repositoryUrl: text("repository_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("releases_project_version_unique").on(t.projectId, t.version),
    index("releases_project_created_idx").on(t.projectId, t.createdAt),
    check(
      "releases_version_check",
      sql`char_length(${t.version}) BETWEEN 1 AND 128 AND ${t.version} !~ '[[:cntrl:]]'`,
    ),
    check(
      "releases_commit_sha_check",
      sql`${t.commitSha} IS NULL OR ${t.commitSha} ~ '^[0-9a-fA-F]{7,64}$'`,
    ),
    check(
      "releases_repository_url_check",
      sql`${t.repositoryUrl} IS NULL OR (char_length(${t.repositoryUrl}) <= 2048 AND ${t.repositoryUrl} ~ '^https?://[^[:space:][:cntrl:]]+$')`,
    ),
  ],
);

/**
 * RS-04 release artifacts: uploaded source maps and their minified assets.
 * `artifact_path` is a canonical POSIX relative path — RS-04 guards NOT
 * NULL + length here; full traversal rejection belongs to RS-06.
 * `storage_key` is server-generated (never client-supplied). The unique
 * guard on (release_id, artifact_path) backs RS-06 upsert/conflict logic;
 * RS-04 provides the constraint plus these repository primitives only.
 */
export const releaseArtifacts = pgTable(
  "release_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    artifactPath: text("artifact_path").notNull(),
    storageKey: text("storage_key").notNull(),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    artifactType: text("artifact_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("release_artifacts_release_path_unique").on(
      t.releaseId,
      t.artifactPath,
    ),
    index("release_artifacts_release_idx").on(t.releaseId),
    index("release_artifacts_release_hash_idx").on(t.releaseId, t.contentHash),
    check(
      "release_artifacts_path_check",
      sql`char_length(${t.artifactPath}) BETWEEN 1 AND 1024`,
    ),
    check(
      "release_artifacts_storage_key_check",
      sql`char_length(${t.storageKey}) BETWEEN 1 AND 1024`,
    ),
    check(
      "release_artifacts_content_hash_check",
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("release_artifacts_size_check", sql`${t.sizeBytes} >= 0`),
    check(
      "release_artifacts_type_check",
      sql`${t.artifactType} IN ('source_map','minified_asset')`,
    ),
  ],
);

/**
 * Telemetry session — unrelated to auth session.
 * Tracks a browser SDK session for a project.
 */
export const telemetrySessions = pgTable(
  "telemetry_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sdkSessionId: text("sdk_session_id").notNull(),
    anonymousUserHash: text("anonymous_user_hash"),
    environment: text("environment").notNull(),
    release: text("release"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    initialUrl: text("initial_url").notNull(),
    browserName: text("browser_name"),
    browserVersion: text("browser_version"),
    osName: text("os_name"),
    osVersion: text("os_version"),
    deviceType: text("device_type"),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    sdkVersion: text("sdk_version").notNull(),
  },
  (t) => [
    unique("telemetry_sessions_project_sdk_unique").on(
      t.projectId,
      t.sdkSessionId,
    ),
    index("telemetry_sessions_project_last_seen_idx").on(
      t.projectId,
      t.lastSeenAt,
    ),
    index("telemetry_sessions_project_started_idx").on(
      t.projectId,
      t.startedAt,
    ),
  ],
);

/**
 * Event processing state enum.
 */
export const processingStateEnum = pgEnum("processing_state", [
  "pending",
  "processed",
  "rejected",
]);

/**
 * Issue — a group of repeated failure events sharing one deterministic
 * fingerprint.
 *
 * `fingerprint` is the SHA-256 grouping key (64 lowercase hex chars).
 * `fingerprint_signature` keeps the canonical normalized signature the hash
 * was derived from, so suspicious collisions stay diagnosable (master spec
 * section 14.5). The signature never replaces the hash as the grouping key.
 */
export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    fingerprintSignature: text("fingerprint_signature").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    normalizedMessage: text("normalized_message").notNull(),
    status: text("status").notNull().default("open"),
    severity: text("severity").notNull(),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    firstRelease: text("first_release"),
    lastRelease: text("last_release"),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    affectedSessionCount: integer("affected_session_count")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("issues_project_fingerprint_unique").on(t.projectId, t.fingerprint),
    index("issues_project_status_last_seen_idx").on(
      t.projectId,
      t.status,
      t.lastSeenAt,
    ),
    index("issues_project_last_seen_idx").on(t.projectId, t.lastSeenAt),
    index("issues_assigned_to_idx").on(t.assignedToUserId),
    // pg_trgm fuzzy search (Block 6): typo-tolerant matching on titles and
    // normalized messages. Extension is enabled in migration 0003.
    index("issues_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("issues_normalized_message_trgm_idx").using(
      "gin",
      t.normalizedMessage.op("gin_trgm_ops"),
    ),
    check(
      "issues_status_check",
      sql`${t.status} IN ('open','investigating','resolved','ignored')`,
    ),
    check("issues_severity_check", sql`${t.severity} IN ('error','warning')`),
    check(
      "issues_type_check",
      sql`${t.type} IN ('exception','unhandled_rejection','console_error','network','message')`,
    ),
    check("issues_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check("issues_occurrence_count_check", sql`${t.occurrenceCount} >= 0`),
    check(
      "issues_affected_session_count_check",
      sql`${t.affectedSessionCount} >= 0`,
    ),
  ],
);

/**
 * Project-local issue tags. `slug` is the deterministic deduplication key:
 * `normalizeTagSlug` maps equivalent spellings to one slug, and
 * `unique(project_id, slug)` enforces a single tag row per project.
 */
export const issueTags = pgTable(
  "issue_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("issue_tags_project_slug_unique").on(t.projectId, t.slug),
    index("issue_tags_project_idx").on(t.projectId),
  ],
);

/**
 * Many-to-many issue↔tag assignments. Composite PK makes assignment
 * idempotent (`ON CONFLICT DO NOTHING`) and unassignment a single delete.
 */
export const issueTagAssignments = pgTable(
  "issue_tag_assignments",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => issueTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "issue_tag_assignments_pk",
      columns: [t.issueId, t.tagId],
    }),
    index("issue_tag_assignments_tag_idx").on(t.tagId),
  ],
);

/**
 * Markdown issue comments. Bodies are capped at 10_000 chars (spec T08
 * 10k-20k bound); rendering must sanitize, never store HTML here.
 */
export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    bodyMarkdown: text("body_markdown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("issue_comments_issue_created_idx").on(t.issueId, t.createdAt),
    check(
      "issue_comments_body_length_check",
      sql`char_length(${t.bodyMarkdown}) <= 10000`,
    ),
  ],
);

/**
 * Append-only issue timeline. Worker-generated rows carry a NULL actor.
 * Historical rows are never updated.
 */
export const issueActivity = pgTable(
  "issue_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    metadataJson: jsonb("metadata_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("issue_activity_issue_created_idx").on(t.issueId, t.createdAt),
    check(
      "issue_activity_type_check",
      sql`${t.type} IN ('created','assigned','unassigned','status_changed','comment_added','regression_detected','reproduction_generated','ai_analysis_requested','ai_analysis_completed','ai_analysis_failed')`,
    ),
  ],
);

/**
 * Distinct telemetry sessions affected by an issue. The composite primary key
 * makes "count distinct sessions" concurrency-safe: `issues.affected_session_count`
 * only increments when this insert actually adds a new relation.
 */
export const issueAffectedSessions = pgTable(
  "issue_affected_sessions",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    telemetrySessionId: uuid("telemetry_session_id")
      .notNull()
      .references(() => telemetrySessions.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "issue_affected_sessions_pk",
      columns: [t.issueId, t.telemetrySessionId],
    }),
    index("issue_affected_sessions_issue_idx").on(t.issueId),
  ],
);

/**
 * In-app notifications foundation. Only `issue_regression` is produced today;
 * the check mirrors the master spec's notification catalogue so later blocks
 * add behavior without a constraint migration. No email, no push, no external
 * delivery is involved.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_user_read_created_idx").on(
      t.userId,
      t.readAt,
      t.createdAt,
    ),
    check(
      "notifications_type_check",
      sql`${t.type} IN ('issue_assigned','issue_comment_mention','issue_regression','reproduction_failed','ai_analysis_completed','ai_analysis_failed')`,
    ),
  ],
);

/**
 * Telemetry events — core fact table.
 * Unique constraint on (project_id, client_event_id) provides idempotency.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    telemetrySessionId: uuid("telemetry_session_id")
      .notNull()
      .references(() => telemetrySessions.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    environment: text("environment").notNull(),
    release: text("release"),
    pageUrl: text("page_url"),
    payloadJson: jsonb("payload_json").notNull(),
    fingerprint: text("fingerprint"),
    issueId: uuid("issue_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    /**
     * RS-08 worker symbolication enrichment (JSONB, nullable). Written once
     * by the worker outside the issue transaction and never by ingest:
     * `{ status, rawFrames, mappedFrames, mappedFrameCount }`. The ingested
     * `payload_json` stays immutable — raw frames are echoed inside the
     * enrichment, never overwritten. Null means "not symbolicated yet"
     * (pre-RS-08 rows, non-issue fast paths that predate enrichment).
     */
    symbolicationJson: jsonb("symbolication_json"),
    processingState: processingStateEnum("processing_state")
      .notNull()
      .default("pending"),
    rejectionReason: text("rejection_reason"),
  },
  (t) => [
    unique("events_project_client_event_unique").on(
      t.projectId,
      t.clientEventId,
    ),
    index("events_project_occurred_idx").on(t.projectId, t.occurredAt),
    index("events_session_sequence_idx").on(
      t.telemetrySessionId,
      t.sequenceNumber,
    ),
    index("events_project_state_idx").on(t.projectId, t.processingState),
    index("events_issue_occurred_idx").on(t.issueId, t.occurredAt),
    check(
      "events_event_type_check",
      sql`${t.eventType} IN ('exception','unhandled_rejection','console_error','network','navigation','click','input','message','custom_breadcrumb','sdk')`,
    ),
    check(
      "events_processing_state_check",
      sql`${t.processingState} IN ('pending','processed','rejected')`,
    ),
    check(
      "events_fingerprint_check",
      sql`${t.fingerprint} IS NULL OR ${t.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Event processing outbox — ensures accepted events are eventually processed.
 * One row per event, inserted in the same transaction as the event.
 *
 * `dispatched_at` means "durably handed to pg-boss", NOT "processed".
 * Final processing state lives on `events.processing_state`.
 */
export const eventProcessingOutbox = pgTable(
  "event_processing_outbox",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("event_processing_outbox_dispatched_idx").on(t.dispatchedAt),
    index("event_processing_outbox_pending_created_idx").on(
      t.dispatchedAt,
      t.createdAt,
    ),
  ],
);

/**
 * Rate limit buckets — per-project, per-key-prefix, per-minute.
 * Atomic upserts provide correct counters without Redis.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyPrefix: text("key_prefix").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
  },
  (t) => [
    unique("rate_limit_buckets_project_prefix_bucket_unique").on(
      t.projectId,
      t.keyPrefix,
      t.bucketStart,
    ),
    index("rate_limit_buckets_bucket_start_idx").on(t.bucketStart),
  ],
);

/**
 * Playwright reproduction tests — one row per generation request.
 *
 * `event_id` and `generated_by_user_id` are nullable with SET NULL so raw
 * occurrence expiry or user deletion never deletes reproduction history.
 * `idempotency_key_hash` backs request dedup (find-by-hash); NULL means
 * "no idempotency key supplied". `completed_at` is set exactly once when
 * the worker marks the row ready/failed.
 */
export const reproductionTests = pgTable(
  "reproduction_tests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    generatedByUserId: text("generated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    language: text("language").notNull().default("typescript"),
    framework: text("framework").notNull().default("playwright"),
    code: text("code"),
    hasRedactedSteps: boolean("has_redacted_steps").notNull().default(false),
    generatorVersion: text("generator_version").notNull(),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    idempotencyKeyHash: text("idempotency_key_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reproduction_tests_issue_created_idx").on(t.issueId, t.createdAt),
    index("reproduction_tests_event_created_idx").on(t.eventId, t.createdAt),
    index("reproduction_tests_generated_by_created_idx").on(
      t.generatedByUserId,
      t.createdAt,
    ),
    index("reproduction_tests_status_idx").on(t.status),
    check(
      "reproduction_tests_status_check",
      sql`${t.status} IN ('pending','ready','failed')`,
    ),
    check(
      "reproduction_tests_language_check",
      sql`${t.language} IN ('typescript')`,
    ),
    check(
      "reproduction_tests_framework_check",
      sql`${t.framework} IN ('playwright')`,
    ),
    check(
      "reproduction_tests_error_code_check",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN ('REPRODUCTION_BASE_URL_REQUIRED','REPRODUCTION_UNSUPPORTED_FAILURE','REPRODUCTION_OUTPUT_TOO_LARGE','REPRODUCTION_INVALID_EVIDENCE','REPRODUCTION_FAILED')`,
    ),
  ],
);

/**
 * Reproduction generation outbox — ensures accepted reproductions are
 * eventually generated. One row per reproduction, inserted in the same
 * transaction as the pending reproduction row.
 *
 * `dispatched_at` means "durably handed to pg-boss", NOT "generated".
 * Final generation state lives on `reproduction_tests.status`.
 */
export const reproductionGenerationOutbox = pgTable(
  "reproduction_generation_outbox",
  {
    reproductionId: uuid("reproduction_id")
      .primaryKey()
      .references(() => reproductionTests.id, { onDelete: "cascade" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reproduction_generation_outbox_dispatched_idx").on(t.dispatchedAt),
    index("reproduction_generation_outbox_pending_created_idx").on(
      t.dispatchedAt,
      t.createdAt,
    ),
  ],
);

/** Drizzle schema map shared by the client factory and migrations. */
export const schema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  workspaces,
  workspaceMemberships,
  projects,
  projectEnvironments,
  projectOrigins,
  projectKeys,
  auditLogs,
  releases,
  releaseArtifacts,
  telemetrySessions,
  issues,
  issueActivity,
  issueAffectedSessions,
  issueTags,
  issueTagAssignments,
  issueComments,
  notifications,
  events,
  eventProcessingOutbox,
  reproductionTests,
  reproductionGenerationOutbox,
  rateLimitBuckets,
} as const;

export type Schema = typeof schema;
