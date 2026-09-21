/**
 * Normalized API error envelope.
 *
 * Mirrors `@replaybug/contracts` errorEnvelopeSchema without importing the
 * contracts package (the browser client stays dependency-light and derives
 * its types from OpenAPI instead). Shape: {code,message,requestId,details?}.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

export interface NormalizeErrorInput {
  status?: number | undefined;
  body?: unknown;
  fallbackRequestId?: string | undefined;
}

/** Typed API failure. Never carries stacks, SQL, cookies or key material. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    if (args.details !== undefined) {
      this.details = args.details;
    }
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
    };
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "AUTH_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED";
  }
}

function statusToMessage(status: number): string {
  switch (status) {
    case 400:
      return "Request validation failed";
    case 401:
      return "Authentication required";
    case 403:
      return "Forbidden";
    case 404:
      return "Not found";
    case 409:
      return "Conflict";
    default:
      return status >= 500 ? "An unexpected error occurred" : "Request failed";
  }
}

/**
 * Normalize any failure payload into an {@link ApiError}, preserving the
 * backend envelope `{code,message,requestId,details}` when present and
 * falling back to a safe generic otherwise. Never throws.
 */
export function normalizeApiError(input: NormalizeErrorInput): ApiError {
  const status =
    typeof input.status === "number" &&
    Number.isInteger(input.status) &&
    input.status > 0
      ? input.status
      : 0;
  const body = input.body;
  if (isRecord(body)) {
    const code = typeof body["code"] === "string" ? body["code"] : undefined;
    const message =
      typeof body["message"] === "string" ? body["message"] : undefined;
    const requestId =
      typeof body["requestId"] === "string" ? body["requestId"] : undefined;
    if (code !== undefined && message !== undefined) {
      return new ApiError({
        code,
        message,
        status,
        requestId: requestId ?? input.fallbackRequestId ?? "unknown",
        ...(body["details"] !== undefined ? { details: body["details"] } : {}),
      });
    }
  }
  const fallbackStatus = status === 0 ? 500 : status;
  return new ApiError({
    code: statusToCode(fallbackStatus),
    message: statusToMessage(fallbackStatus),
    status: fallbackStatus,
    requestId: input.fallbackRequestId ?? "unknown",
  });
}

/** Extract field-level validation details when the backend sent them. */
export function validationDetails(error: ApiError): Array<{
  path: string;
  message: string;
}> {
  if (!Array.isArray(error.details)) {
    return [];
  }
  const out: Array<{ path: string; message: string }> = [];
  for (const item of error.details) {
    if (!isRecord(item)) {
      continue;
    }
    const path = typeof item["path"] === "string" ? item["path"] : "";
    const message = typeof item["message"] === "string" ? item["message"] : "";
    if (message.length > 0) {
      out.push({ path, message });
    }
  }
  return out;
}
