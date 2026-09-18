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
  telemetrySessions,
  issues,
  issueActivity,
  issueAffectedSessions,
  notifications,
  events,
  eventProcessingOutbox,
  rateLimitBuckets,
} as const;

export type Schema = typeof schema;
