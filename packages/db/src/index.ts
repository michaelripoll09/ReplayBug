export { loadDbConfigFromEnv, dbConfigSchema } from "./config.js";
export type { DbConfig } from "./config.js";
export { createDbClient, checkDbHealth } from "./client.js";
export type { DbClient, HealthCheckable } from "./client.js";
export { schema } from "./schema.js";
export {
  ARTIFACT_TYPES,
  RELEASE_VERSION_MAX_LENGTH,
  REPOSITORY_URL_MAX_LENGTH,
  ARTIFACT_PATH_MAX_LENGTH,
  STORAGE_KEY_MAX_LENGTH,
  ReleaseValidationError,
  validateArtifactPath,
  validateArtifactType,
  validateCommitSha,
  validateContentHash,
  validateReleaseVersion,
  validateRepositoryUrl,
  validateSizeBytes,
  validateStorageKey,
} from "./releases.js";
export type { ArtifactType } from "./releases.js";
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
  processingStateEnum,
} from "./schema.js";
export { normalizeTagSlug } from "./domain/index.js";
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
  selectExceptionFingerprintFrames,
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
  generateSecretToken,
  parseSecretToken,
  hashSecretToken,
  verifySecretToken,
  SECRET_KEY_PREFIX,
  SecretTokenError,
} from "./keys-crypto.js";
export type {
  ParsedPublicKey,
  ParsedSecretToken,
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
export * as ReleaseRepo from "./repositories/releases.js";
export type {
  ReleaseRow,
  ReleaseArtifactRow,
  CreateReleaseInput,
  CreateReleaseResult,
  InsertReleaseArtifactInput,
} from "./repositories/releases.js";
export * as AuditRepo from "./repositories/audit.js";
export * as TelemetryRepo from "./repositories/telemetry.js";
export * as IssueRepo from "./repositories/issues.js";
export * as IssueActivityRepo from "./repositories/issue-activity.js";
export * as IssueAffectedSessionRepo from "./repositories/issue-affected-sessions.js";
export * as TagRepo from "./repositories/tags.js";
export * as IssueCommentRepo from "./repositories/comments.js";
export * as UserRepo from "./repositories/users.js";
export * as IssueListRepo from "./repositories/issue-list.js";
export * as MetricsRepo from "./repositories/metrics.js";
export * as SessionRepo from "./repositories/sessions.js";
export * as OccurrenceRepo from "./repositories/occurrences.js";
export * as EventProcessingRepo from "./repositories/event-processing.js";
export * as OutboxRepo from "./repositories/outbox.js";
export * as ReproductionRepo from "./repositories/reproductions.js";
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
  insertPendingReproduction,
  findReproductionById,
  lockReproductionById,
  findReproductionByIdempotency,
  encodeReproductionCursor,
  decodeReproductionCursor,
  listIssueReproductions,
  markReproductionReady,
  markReproductionFailed,
  insertReproductionActivity,
  insertReproductionOutbox,
  claimPendingReproductionOutboxBatch,
  claimStaleReproductionOutboxBatch,
  listStaleReproductionOutbox,
  markReproductionOutboxDispatched,
  recordReproductionOutboxFailure,
  REPRODUCTION_STATUSES,
  REPRODUCTION_ERROR_CODES,
} from "./repositories/reproductions.js";
export type {
  ReproductionRow,
  ReproductionOutboxRow,
  ReproductionStatus,
  ReproductionErrorCode,
  CreatePendingReproductionInput,
  ReproductionCursor,
  ListIssueReproductionsInput,
  ListIssueReproductionsResult,
  MarkReproductionReadyInput,
  MarkReproductionFailedInput,
  CreateReproductionActivityInput,
  PendingReproductionOutboxItem,
} from "./repositories/reproductions.js";
export {
  lockEventForProcessing,
  getEventForSymbolication,
  persistEventSymbolication,
  markEventProcessed,
  markEventRejected,
} from "./repositories/event-processing.js";
export type {
  EventForProcessing,
  EventProcessingState,
  EventSymbolicationPreload,
} from "./repositories/event-processing.js";
export {
  lockIssueByFingerprint,
  insertIssueIfAbsent,
  recordIssueOccurrence,
  findIssueById,
  lockIssueById,
  updateIssueRow,
  ISSUE_STATUSES,
} from "./repositories/issues.js";
export {
  encodeIssueCursor,
  decodeIssueCursor,
  listIssues,
} from "./repositories/issue-list.js";
export type {
  IssueListSort,
  IssueListOrder,
  IssueListCursor,
  ListIssuesInput,
  ListIssuesResult,
} from "./repositories/issue-list.js";
export {
  getProjectMetrics,
  floorBucket,
  bucketMillis,
} from "./repositories/metrics.js";
export type {
  MetricsBucketSize,
  MetricsWindow,
  MetricsBucket,
  MetricsResult,
} from "./repositories/metrics.js";
export {
  encodeOccurrenceCursor,
  decodeOccurrenceCursor,
  findEventById,
  listIssueOccurrences,
} from "./repositories/occurrences.js";
export type {
  OccurrenceCursor,
  ListOccurrencesInput,
  ListOccurrencesResult,
} from "./repositories/occurrences.js";
export {
  encodeSessionCursor,
  decodeSessionCursor,
  encodeEventCursor,
  decodeEventCursor,
  findSessionById,
  listSessions,
  listSessionEvents,
  getTimelineContext,
} from "./repositories/sessions.js";
export type {
  SessionCursor,
  ListSessionsInput,
  ListSessionsResult,
  EventCursor,
  ListSessionEventsInput,
  ListSessionEventsResult,
  TimelineContext,
} from "./repositories/sessions.js";
export type {
  IssueRow,
  IssueStatus,
  CreateIssueInput,
  RecordIssueOccurrenceInput,
  UpdateIssueRowPatch,
} from "./repositories/issues.js";
export {
  insertIssueActivity,
  listIssueActivity,
  listIssueActivityPaged,
  encodeActivityCursor,
  decodeActivityCursor,
  ISSUE_ACTIVITY_TYPES,
} from "./repositories/issue-activity.js";
export type {
  IssueActivityRow,
  IssueActivityType,
  CreateIssueActivityInput,
  ActivityCursor,
  ListActivityInput,
  ListActivityResult,
} from "./repositories/issue-activity.js";
export { recordIssueAffectedSession } from "./repositories/issue-affected-sessions.js";
export type {
  IssueAffectedSessionRow,
  RecordIssueAffectedSessionInput,
} from "./repositories/issue-affected-sessions.js";
export {
  insertNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  encodeNotificationCursor,
  decodeNotificationCursor,
  NOTIFICATION_TYPES,
} from "./repositories/notifications.js";
export type {
  NotificationRow,
  NotificationType,
  CreateNotificationInput,
  NotificationCursor,
  ListNotificationsInput,
  ListNotificationsResult,
} from "./repositories/notifications.js";
export { findUsersByIds } from "./repositories/users.js";
export type { UserRow } from "./repositories/users.js";
export {
  notifyProjectIssueUpdate,
  PROJECT_UPDATES_CHANNEL,
  PROJECT_UPDATE_VERSION,
} from "./repositories/project-updates.js";
export type {
  ProjectUpdateNotification,
  ProjectUpdateType,
} from "./repositories/project-updates.js";
