/**
 * Domain errors: server-side, consistent codes, anti-enumeration safe.
 * Testable without Fastify: pure classes + a mapper to HTTP status.
 * Never include SQL, stacks, hashes or cookies in messages.
 */

export type DomainErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "ALREADY_WORKSPACE_MEMBER"
  | "ACTIVE_INVITATION_EXISTS"
  | "INVITATION_INVALID"
  | "INVITATION_ALREADY_USED"
  | "RELEASE_VERSION_CONFLICT"
  | "ARTIFACT_PATH_INVALID"
  | "ARTIFACT_PATH_CONFLICT"
  | "INVALID_ARTIFACT_TYPE"
  | "INVALID_SOURCE_MAP"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_STORAGE_UNAVAILABLE"
  | "REPRODUCTION_BASE_URL_REQUIRED"
  | "REPRODUCTION_UNSUPPORTED_FAILURE"
  | "AI_NOT_CONFIGURED"
  | "INTERNAL_ERROR";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: unknown;

  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function authRequired(message = "Authentication required"): DomainError {
  return new DomainError("AUTH_REQUIRED", message);
}

export function forbidden(message = "Forbidden"): DomainError {
  return new DomainError("FORBIDDEN", message);
}

export function notFound(resource = "Resource"): DomainError {
  // Anti-enumeration: callers use generic "not found" for cross-tenant
  // access so existence is never revealed to unauthorized users.
  return new DomainError("NOT_FOUND", `${resource} not found`);
}

export function validationError(
  message: string,
  details?: unknown,
): DomainError {
  return new DomainError("VALIDATION_ERROR", message, details);
}

/** Safe response for missing, extra, or mismatched destructive confirmation. */
export function requireConfirmationError(): DomainError {
  return validationError("Deletion confirmation does not match");
}

export function conflict(message: string, details?: unknown): DomainError {
  return new DomainError("CONFLICT", message, details);
}

export function alreadyWorkspaceMember(): DomainError {
  return new DomainError(
    "ALREADY_WORKSPACE_MEMBER",
    "The invited email already belongs to a workspace member",
  );
}

export function activeInvitationExists(): DomainError {
  return new DomainError(
    "ACTIVE_INVITATION_EXISTS",
    "An active invitation already exists for this email",
  );
}

/** Safe for malformed, expired, revoked, or wrong-email credentials. */
export function invitationInvalid(): DomainError {
  return new DomainError(
    "INVITATION_INVALID",
    "Invitation is invalid or unavailable",
  );
}

/** Safe conflict returned after a valid invitation has already been accepted. */
export function invitationAlreadyUsed(): DomainError {
  return new DomainError(
    "INVITATION_ALREADY_USED",
    "Invitation is invalid or unavailable",
  );
}

/**
 * RS-04 release identity conflict: the version exists with different
 * commit_sha/repository_url. Maps to HTTP 409 with a stable code the CLI
 * (RS-07) can branch on.
 */
export function releaseVersionConflict(
  message = "Release version already exists with different metadata",
): DomainError {
  return new DomainError("RELEASE_VERSION_CONFLICT", message);
}

export function internalError(
  message = "An unexpected error occurred",
): DomainError {
  return new DomainError("INTERNAL_ERROR", message);
}

/**
 * RS-06 artifact upload errors. Codes are stable for CLI branching
 * (RS-07): path/type/map rejections are 400, path conflicts 409,
 * over-limit payloads 413, storage outages 503 (ingest stays up).
 */
export function artifactPathInvalid(
  message = "Invalid artifact path",
): DomainError {
  return new DomainError("ARTIFACT_PATH_INVALID", message);
}

export function artifactPathConflict(
  message = "Artifact path already exists with different content",
): DomainError {
  return new DomainError("ARTIFACT_PATH_CONFLICT", message);
}

export function invalidArtifactType(
  message = "Invalid artifact type",
): DomainError {
  return new DomainError("INVALID_ARTIFACT_TYPE", message);
}

export function invalidSourceMap(message = "Invalid source map"): DomainError {
  return new DomainError("INVALID_SOURCE_MAP", message);
}

export function artifactTooLarge(
  message = "Artifact exceeds the size limit",
): DomainError {
  return new DomainError("ARTIFACT_TOO_LARGE", message);
}

export function artifactStorageUnavailable(
  message = "Artifact storage is temporarily unavailable",
): DomainError {
  return new DomainError("ARTIFACT_STORAGE_UNAVAILABLE", message);
}

export function reproductionBaseUrlRequired(
  message = "Configure the base URL for this environment before generating a test",
): DomainError {
  return new DomainError("REPRODUCTION_BASE_URL_REQUIRED", message);
}

export function reproductionUnsupportedFailure(
  message = "This failure type cannot be reproduced deterministically",
): DomainError {
  return new DomainError("REPRODUCTION_UNSUPPORTED_FAILURE", message);
}

/** AI analysis is disabled or misconfigured; request cannot be accepted. */
export function aiAnalysisNotConfigured(
  message = "AI analysis is not configured",
): DomainError {
  return new DomainError("AI_NOT_CONFIGURED", message);
}

/** Map a domain code to HTTP status. */
export function statusForCode(code: DomainErrorCode): number {
  switch (code) {
    case "AUTH_REQUIRED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 400;
    case "CONFLICT":
    case "ALREADY_WORKSPACE_MEMBER":
    case "ACTIVE_INVITATION_EXISTS":
    case "INVITATION_ALREADY_USED":
      return 409;
    case "INVITATION_INVALID":
      return 404;
    case "RELEASE_VERSION_CONFLICT":
      return 409;
    case "ARTIFACT_PATH_CONFLICT":
      return 409;
    case "ARTIFACT_PATH_INVALID":
    case "INVALID_ARTIFACT_TYPE":
    case "INVALID_SOURCE_MAP":
      return 400;
    case "ARTIFACT_TOO_LARGE":
      return 413;
    case "ARTIFACT_STORAGE_UNAVAILABLE":
      return 503;
    case "REPRODUCTION_BASE_URL_REQUIRED":
    case "REPRODUCTION_UNSUPPORTED_FAILURE":
      return 422;
    case "AI_NOT_CONFIGURED":
      return 503;
    case "INTERNAL_ERROR":
      return 500;
  }
}

/** True for Postgres unique violations (code 23505), including Drizzle wrappers. */
export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 &&
    current !== null &&
    typeof current === "object" &&
    !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const record = current as {
      code?: unknown;
      cause?: unknown;
      message?: unknown;
    };
    if (record.code === "23505") {
      return true;
    }
    if (
      typeof record.message === "string" &&
      record.message.includes("23505")
    ) {
      return true;
    }
    if (
      typeof record.message === "string" &&
      /unique|duplicate/i.test(record.message) &&
      /constraint|key|violat/i.test(record.message)
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}
