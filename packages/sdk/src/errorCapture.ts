import { sanitizeString, sanitizeContext } from "./sanitize.js";
import {
  generateUuid,
  nowIso,
  type Breadcrumb,
  type ClientEvent,
} from "./config.js";
import { createBreadcrumb } from "./breadcrumbs.js";
import { parseStackFrames } from "./stackParser.js";
import type { SdkState } from "./config.js";

/**
 * Error capture configuration
 */
export interface ErrorCaptureConfig {
  captureConsoleErrors: boolean;
  onErrorEvent: (event: ClientEvent) => void;
  onBreadcrumb: (breadcrumb: Breadcrumb) => void;
}

/**
 * Setup global error handlers
 */
export function setupErrorCapture(
  state: SdkState,
  config: ErrorCaptureConfig,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  // window.error handler
  const errorHandler = (event: ErrorEvent) => {
    // Don't capture errors from our own SDK
    if (event.filename && event.filename.includes("/replaybug/")) return;

    const error = event.error;
    const payload = buildExceptionPayload(
      error,
      event.message,
      event.filename,
      event.lineno,
      event.colno,
    );

    const clientEvent = createClientEvent(state, "exception", payload);
    config.onErrorEvent(clientEvent);
  };
  window.addEventListener("error", errorHandler);
  state.errorHandler = errorHandler;

  // unhandledrejection handler
  const rejectionHandler = (event: PromiseRejectionEvent) => {
    // Don't capture if already handled
    if (
      event.reason &&
      typeof event.reason === "object" &&
      "__replaybug_handled__" in event.reason
    )
      return;

    const reason = normalizeRejectionReason(event.reason);
    const payload = {
      reason,
      promise: String(event.promise),
    };

    const clientEvent = createClientEvent(
      state,
      "unhandled_rejection",
      payload,
    );
    config.onErrorEvent(clientEvent);
  };
  window.addEventListener("unhandledrejection", rejectionHandler);
  state.rejectionHandler = rejectionHandler;

  // console.error wrapping
  let originalConsoleError: typeof console.error | null = null;
  if (config.captureConsoleErrors) {
    originalConsoleError = console.error.bind(console);
    state.originalConsoleError = originalConsoleError;

    console.error = (...args: unknown[]) => {
      // Don't capture our own debug logs
      if (
        args[0] &&
        typeof args[0] === "string" &&
        args[0].startsWith("[ReplayBug]")
      ) {
        originalConsoleError?.apply(console, args);
        return;
      }

      // Create breadcrumb
      const breadcrumb = createBreadcrumb("console", {
        message: args.map(String).join(" "),
        level: "error",
        data: { args: args.map(String) },
        event_type: "console_error",
      });
      config.onBreadcrumb(breadcrumb);

      // Create event
      const payload = {
        args: args.map(String),
      };
      const clientEvent = createClientEvent(state, "console_error", payload);
      config.onErrorEvent(clientEvent);

      // Call original
      originalConsoleError?.apply(console, args);
    };
  }

  // Return cleanup function
  return () => {
    window.removeEventListener("error", errorHandler);
    window.removeEventListener("unhandledrejection", rejectionHandler);
    if (originalConsoleError) {
      console.error = originalConsoleError;
    }
  };
}

/**
 * Build exception payload from error
 */
function buildExceptionPayload(
  error: Error | null,
  message: string,
  filename: string,
  lineno: number,
  colno: number,
): Record<string, unknown> {
  const frames: Array<Record<string, unknown>> = [];

  if (error?.stack) {
    const stackFrames = parseStackTrace(error.stack);
    for (const frame of stackFrames) {
      frames.push(frame);
    }
  } else if (filename) {
    frames.push({
      filename: sanitizeString(filename),
      function: "?",
      lineno,
      colno,
      in_app: true,
    });
  }

  return {
    values: [
      {
        type: error?.name || "Error",
        value: sanitizeString(message || error?.message || "Unknown error"),
        module: error?.constructor.name,
        stacktrace: frames.length > 0 ? { frames } : undefined,
        mechanism: {
          type: "generic",
          handled: false,
        },
      },
    ],
  };
}

/**
 * Parse stack trace into frames (linear deterministic parser).
 */
function parseStackTrace(stack: string): Array<Record<string, unknown>> {
  return parseStackFrames(stack, 100); // Max 100 frames
}

/**
 * Normalize rejection reason to string
 */
function normalizeRejectionReason(reason: unknown): string {
  if (reason === null || reason === undefined) {
    return "Promise rejected with no reason";
  }
  if (reason instanceof Error) {
    return reason.message || reason.name || "Error";
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Create client event with current state
 */
function createClientEvent(
  state: SdkState,
  eventType: string,
  payload: Record<string, unknown>,
): ClientEvent {
  const eventId = generateUuid();
  const sequence = state.sequence++;

  return {
    event_id: eventId,
    sequence_number: sequence,
    event_type: eventType,
    timestamp: nowIso(),
    tags: { ...state.tags },
    context: sanitizeContext({ ...state.context }),
    breadcrumbs: state.breadcrumbs.getAll(),
    payload,
  };
}
