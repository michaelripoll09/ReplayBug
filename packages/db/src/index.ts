export { loadDbConfigFromEnv, dbConfigSchema } from "./config.js";
export type { DbConfig } from "./config.js";
export { createDbClient, checkDbHealth } from "./client.js";
export type { DbClient, HealthCheckable } from "./client.js";
export { schema } from "./schema.js";
export {
  users,
  sessions,
  accounts,
  verifications,
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
  processingStateEnum,
} from "./schema.js";
export {
  NORMALIZED_PLACEHOLDER,
  capText,
  normalizeMessage,
  normalizePath,
  normalizePathSegment,
  normalizeFilename,
  normalizeStackFrame,
  formatStackFrame,
  selectTopFrames,
  ISSUE_TYPES,
  ISSUE_SEVERITIES,
  NON_ISSUE_EVENT_TYPES,
  StoredEventPayloadError,
  buildFingerprintSignature,
  hashFingerprint,
  normalizeCustomFingerprint,
  deriveEventProcessingPlan,
} from "./domain/index.js";
export type {
  NormalizableStackFrame,
  CanonicalStackFrame,
  IssueType,
  IssueSeverity,
  IssueDescriptor,
  DeriveEventInput,
  EventProcessingPlan,
  StoredEventRejectionCode,
} from "./domain/index.js";
export {
  parseOrigin,
  parseBaseUrl,
  isLocalhostOrigin,
  OriginParseError,
} from "./origin.js";
export {
  generatePublicKey,
  parsePublicKey,
  hashPublicKey,
  verifyPublicKey,
  deriveAnonymousUserHash,
  PUBLIC_KEY_PREFIX,
  PublicKeyError,
} from "./keys-crypto.js";
export type {
  ParsedPublicKey,
  DeriveAnonymousUserHashInput,
} from "./keys-crypto.js";
export type {
  Database,
  DbTransaction,
  DbOrTx,
} from "./repositories/db-types.js";
export * as WorkspaceRepo from "./repositories/workspaces.js";
export * as MembershipRepo from "./repositories/memberships.js";
export * as ProjectRepo from "./repositories/projects.js";
export * as EnvironmentRepo from "./repositories/environments.js";
export * as OriginRepo from "./repositories/origins.js";
export * as ProjectKeyRepo from "./repositories/keys.js";
export * as AuditRepo from "./repositories/audit.js";
export * as TelemetryRepo from "./repositories/telemetry.js";
export * as IssueRepo from "./repositories/issues.js";
export * as IssueActivityRepo from "./repositories/issue-activity.js";
export * as IssueAffectedSessionRepo from "./repositories/issue-affected-sessions.js";
export * as EventProcessingRepo from "./repositories/event-processing.js";
export * as OutboxRepo from "./repositories/outbox.js";
export * as NotificationRepo from "./repositories/notifications.js";
export * as ProjectUpdatesRepo from "./repositories/project-updates.js";
export {
  sanitizeUrl,
  sanitizeString,
  sanitizeContext,
  redactSecrets,
  isSensitiveParam,
  isSensitiveKey,
  truncateToBytes,
  sanitizeEventPayload,
  sanitizeBatchRequest,
} from "./sanitize.js";

export {
  upsertTelemetrySession,
  insertEvent,
  eventExists,
  checkAndIncrementRateLimit,
  findKeyByPrefix,
  listOriginsByProject,
} from "./repositories/telemetry.js";
export {
  insertOutbox,
  claimPendingOutboxBatch,
  claimStaleOutboxBatch,
  listStaleOutbox,
  markOutboxDispatched,
  recordOutboxDispatchFailure,
} from "./repositories/outbox.js";
export type { OutboxRow, PendingOutboxItem } from "./repositories/outbox.js";
export {
  lockEventForProcessing,
  markEventProcessed,
  markEventRejected,
} from "./repositories/event-processing.js";
export type {
  EventForProcessing,
  EventProcessingState,
} from "./repositories/event-processing.js";
export {
  lockIssueByFingerprint,
  insertIssueIfAbsent,
  recordIssueOccurrence,
  findIssueById,
  ISSUE_STATUSES,
} from "./repositories/issues.js";
export type {
  IssueRow,
  IssueStatus,
  CreateIssueInput,
  RecordIssueOccurrenceInput,
} from "./repositories/issues.js";
export {
  insertIssueActivity,
  listIssueActivity,
  ISSUE_ACTIVITY_TYPES,
} from "./repositories/issue-activity.js";
export type {
  IssueActivityRow,
  IssueActivityType,
  CreateIssueActivityInput,
} from "./repositories/issue-activity.js";
export { recordIssueAffectedSession } from "./repositories/issue-affected-sessions.js";
export type {
  IssueAffectedSessionRow,
  RecordIssueAffectedSessionInput,
} from "./repositories/issue-affected-sessions.js";
export {
  insertNotification,
  NOTIFICATION_TYPES,
} from "./repositories/notifications.js";
export type {
  NotificationRow,
  NotificationType,
  CreateNotificationInput,
} from "./repositories/notifications.js";
export {
  notifyProjectIssueUpdate,
  PROJECT_UPDATES_CHANNEL,
  PROJECT_UPDATE_VERSION,
} from "./repositories/project-updates.js";
export type {
  ProjectUpdateNotification,
  ProjectUpdateType,
} from "./repositories/project-updates.js";
