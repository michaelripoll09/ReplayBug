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
  events,
  eventProcessingOutbox,
  rateLimitBuckets,
  processingStateEnum,
} from "./schema.js";
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
  PUBLIC_KEY_PREFIX,
  PublicKeyError,
} from "./keys-crypto.js";
export type { ParsedPublicKey } from "./keys-crypto.js";
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
  insertOutbox,
  checkAndIncrementRateLimit,
  findKeyByPrefix,
  listOriginsByProject,
} from "./repositories/telemetry.js";
