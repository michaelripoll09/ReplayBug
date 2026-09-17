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

export function conflict(message: string, details?: unknown): DomainError {
  return new DomainError("CONFLICT", message, details);
}

export function internalError(
  message = "An unexpected error occurred",
): DomainError {
  return new DomainError("INTERNAL_ERROR", message);
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
      return 409;
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
