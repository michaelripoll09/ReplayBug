import { PROTOCOL_VERSION, TELEMETRY_LIMITS } from "@replaybug/contracts";
import { SDK_VERSION, SDK_NAME, SDK_PROTOCOL_VERSION } from "./version.js";
import {
  parseDsn,
  generateSessionId,
  generateUuid,
  nowIso,
  getBrowserMetadata,
  type ReplayBugOptions,
  type SdkState,
  type ClientEvent,
  type Breadcrumb,
  type SessionMetadata,
  DEFAULT_OPTIONS,
} from "./config.js";
import {
  sanitizeUrl,
  sanitizeString,
  sanitizeContext,
  sanitizeEventPayload,
} from "./sanitize.js";
import { BreadcrumbBuffer, createBreadcrumb } from "./breadcrumbs.js";
import { createTransport, type Transport } from "./transport.js";
import { createEventQueue, type EventQueue } from "./queue.js";
import { setupNetworkCapture } from "./autoCapture.js";
import { setupClickCapture } from "./autoCapture.js";
import { setupNavigationCapture } from "./autoCapture.js";
import { setupErrorCapture } from "./errorCapture.js";

/**
 * Internal SDK options with all required fields filled in.
 */
type InternalOptions = Required<Omit<ReplayBugOptions, "beforeSend">> & {
  beforeSend: ReplayBugOptions["beforeSend"];
};

/**
 * Main ReplayBug SDK class
 */
export class ReplayBug {
  private state: SdkState;
  private queue: EventQueue | null = null;
  private transport: Transport | null = null;
  private cleanupFns: (() => void)[] = [];

  constructor() {
    this.state = {
      initialized: false,
      options: { ...DEFAULT_OPTIONS, dsn: "" } as InternalOptions,
      sessionId: "",
      sequence: 0,
      breadcrumbs: new BreadcrumbBuffer(DEFAULT_OPTIONS.maxBreadcrumbs),
      userId: null,
      userHash: null,
      tags: {},
      context: {},
      transport: null,
      originalConsoleError: null,
      originalFetch: null,
      originalXhrOpen: null,
      originalXhrSend: null,
      originalPushState: null,
      originalReplaceState: null,
      popstateHandler: null,
      clickHandler: null,
      errorHandler: null,
      rejectionHandler: null,
      unloadHandler: null,
    };
  }

  /**
   * Initialize the SDK
   */
  init(options: ReplayBugOptions): void {
    if (this.state.initialized) {
      this.debug("init() called on already initialized SDK, ignoring");
      return;
    }

    // Parse DSN
    let dsnResult;
    try {
      dsnResult = parseDsn(options.dsn);
    } catch (error) {
      this.debug(
        `Invalid DSN: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.state.options = {
        ...DEFAULT_OPTIONS,
        dsn: options.dsn,
        enabled: false,
      } as InternalOptions;
      this.state.initialized = true;
      return;
    }

    // Merge options with defaults
    const mergedOptions = {
      ...DEFAULT_OPTIONS,
      ...options,
      tags: { ...DEFAULT_OPTIONS.tags, ...options.tags },
      safeInputSelectors: options.safeInputSelectors || [],
      denyUrls: options.denyUrls || [],
    } as InternalOptions;

    this.state.options = mergedOptions;
    this.state.sessionId = generateSessionId();
    this.state.sequence = 0;
    this.state.breadcrumbs = new BreadcrumbBuffer(mergedOptions.maxBreadcrumbs);
    this.state.tags = { ...mergedOptions.tags };
    this.state.initialized = true;

    // Create transport
    this.transport = createTransport(
      dsnResult.baseUrl,
      dsnResult.publicKey,
      mergedOptions.debug,
    );
    this.state.transport = this.transport;

    // Create queue
    this.queue = createEventQueue(this.transport, {
      debug: mergedOptions.debug,
      onDebug: (msg) => this.debug(msg),
    });

    // Setup auto-capture
    this.setupAutoCapture();

    // Setup unload handler
    this.setupUnloadHandler();

    // Add init breadcrumb
    this.addBreadcrumbInternal(
      createBreadcrumb("sdk", {
        message: "SDK initialized",
        data: {
          environment: mergedOptions.environment,
          release: mergedOptions.release,
        },
        event_type: "sdk",
      }),
    );

    this.debug(
      `SDK initialized: session=${this.state.sessionId}, env=${mergedOptions.environment}`,
    );
  }

  /**
   * Setup all auto-capture mechanisms
   */
  private setupAutoCapture(): void {
    const opts = this.state.options;

    // Network capture
    if (opts.captureFailedRequests) {
      const cleanup = setupNetworkCapture(this.state, {
        captureFailedRequests: true,
        denyUrls: opts.denyUrls,
        onNetworkEvent: (breadcrumb) => this.addBreadcrumbInternal(breadcrumb),
      });
      this.cleanupFns.push(cleanup);
    }

    // Click capture
    if (opts.captureClicks) {
      const cleanup = setupClickCapture(this.state, {
        captureClicks: true,
        onClickEvent: (breadcrumb) => this.addBreadcrumbInternal(breadcrumb),
      });
      this.cleanupFns.push(cleanup);
    }

    // Navigation capture
    if (opts.captureNavigation) {
      const cleanup = setupNavigationCapture(this.state, {
        captureNavigation: true,
        onNavigationEvent: (breadcrumb) =>
          this.addBreadcrumbInternal(breadcrumb),
      });
      this.cleanupFns.push(cleanup);
    }

    // Error capture
    const cleanup = setupErrorCapture(this.state, {
      captureConsoleErrors: opts.captureConsoleErrors,
      onErrorEvent: (event) => this.sendEvent(event),
      onBreadcrumb: (breadcrumb) => this.addBreadcrumbInternal(breadcrumb),
    });
    this.cleanupFns.push(cleanup);
  }

  /**
   * Setup beforeunload handler for flush
   */
  private setupUnloadHandler(): void {
    if (typeof window === "undefined") return;

    const unloadHandler = () => {
      this.flushSync();
    };
    window.addEventListener("beforeunload", unloadHandler);
    this.state.unloadHandler = unloadHandler;
  }

  /**
   * Send an event through the queue
   */
  private sendEvent(event: ClientEvent): void {
    if (!this.state.options.enabled) return;

    // Apply sampling for non-critical events
    const isCritical = ["exception", "unhandled_rejection"].includes(
      event.event_type,
    );
    if (!isCritical && this.state.options.sampleRate < 1) {
      if (Math.random() > this.state.options.sampleRate) {
        this.debug(`Event ${event.event_type} dropped by sampling`);
        return;
      }
    }

    // Apply beforeSend
    let finalEvent = event;
    if (this.state.options.beforeSend) {
      try {
        const result = this.state.options.beforeSend(event);
        if (result === null) {
          this.debug(`Event ${event.event_type} dropped by beforeSend`);
          return;
        }
        finalEvent = result;
      } catch (error) {
        this.debug(
          `beforeSend threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Use original event on beforeSend error
      }
    }

    // Re-sanitize after beforeSend (defense in depth)
    finalEvent = {
      ...finalEvent,
      context: sanitizeContext(finalEvent.context),
      payload: sanitizeEventPayload(finalEvent.payload),
    };

    // Enqueue
    this.queue?.enqueue(finalEvent);
  }

  /**
   * Add breadcrumb to ring buffer
   */
  private addBreadcrumbInternal(breadcrumb: Breadcrumb): void {
    this.state.breadcrumbs.add(breadcrumb);
  }

  /**
   * Public API: captureException
   */
  captureException(error: Error, context?: Record<string, unknown>): string {
    const eventId = generateUuid();
    const payload = {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: error.stack
            ? { frames: parseStackFrames(error.stack) }
            : undefined,
          mechanism: { type: "generic", handled: true },
        },
      ],
    };
    const event = this.createEvent("exception", payload, context);
    this.sendEvent(event);
    return eventId;
  }

  /**
   * Public API: captureMessage
   */
  captureMessage(
    message: string,
    level: "debug" | "info" | "warning" | "error" | "critical" = "info",
    context?: Record<string, unknown>,
  ): string {
    const eventId = generateUuid();
    const payload = { message, level };
    const event = this.createEvent("message", payload, context);
    this.sendEvent(event);
    return eventId;
  }

  /**
   * Public API: addBreadcrumb
   */
  addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp">): void {
    const fullBreadcrumb = createBreadcrumb(breadcrumb.type, breadcrumb);
    this.addBreadcrumbInternal(fullBreadcrumb);
  }

  /**
   * Public API: setUser
   */
  setUser(user: { id: string } | null): void {
    if (user?.id) {
      this.state.userId = user.id;
      // Server will derive HMAC hash; we don't compute it client-side
      this.debug(`User set: ${user.id}`);
    } else {
      this.state.userId = null;
      this.state.userHash = null;
    }
  }

  /**
   * Public API: clearUser
   */
  clearUser(): void {
    this.setUser(null);
  }

  /**
   * Public API: setTag
   */
  setTag(key: string, value: string): void {
    this.state.tags[key] = value;
  }

  /**
   * Public API: setTags
   */
  setTags(tags: Record<string, string>): void {
    this.state.tags = { ...this.state.tags, ...tags };
  }

  /**
   * Public API: setContext
   */
  setContext(key: string, value: unknown): void {
    this.state.context[key] = value;
  }

  /**
   * Public API: flush
   */
  async flush(timeoutMs = 5000): Promise<void> {
    if (!this.queue) return;
    const startTime = Date.now();
    while (this.queue.size() > 0 && Date.now() - startTime < timeoutMs) {
      await this.queue.flush();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Public API: close
   */
  async close(): Promise<void> {
    if (!this.state.initialized) return;

    // Remove unload handler
    if (this.state.unloadHandler && typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.state.unloadHandler);
    }

    // Flush remaining events
    await this.flush(5000);

    // Run cleanup functions
    for (const cleanup of this.cleanupFns) {
      try {
        cleanup();
      } catch (error) {
        this.debug(
          `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.cleanupFns = [];

    // Close queue and transport
    await this.queue?.close();
    await this.transport?.close();

    this.state.initialized = false;
    this.queue = null;
    this.transport = null;
    this.debug("SDK closed");
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.state.initialized;
  }

  /**
   * Create a client event with current state
   */
  private createEvent(
    eventType: string,
    payload: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): ClientEvent {
    const eventId = generateUuid();
    const sequence = this.state.sequence++;

    // Add session metadata to payload for first event
    if (sequence === 0) {
      payload = {
        ...payload,
        _session_metadata: this.buildSessionMetadata(),
      };
    }

    return {
      event_id: eventId,
      sequence_number: sequence,
      event_type: eventType,
      timestamp: nowIso(),
      tags: { ...this.state.tags },
      context: sanitizeContext({ ...this.state.context, ...context }),
      breadcrumbs: this.state.breadcrumbs.getAll(),
      payload: sanitizeEventPayload(payload),
    };
  }

  /**
   * Build session metadata for first event
   */
  private buildSessionMetadata(): SessionMetadata {
    const browser = getBrowserMetadata();
    return {
      sdk_session_id: this.state.sessionId,
      browser,
      initial_url: sanitizeUrl(
        typeof window !== "undefined" ? window.location.href : "",
      ),
      release: this.state.options.release,
      environment: this.state.options.environment,
      tags: { ...this.state.tags },
    };
  }

  /**
   * Synchronous flush for unload
   */
  private flushSync(): void {
    if (!this.queue || typeof navigator === "undefined") return;
    // Use sendBeacon if available and payload is small
    // For now, just use fetch with keepalive (already handled by transport)
    this.queue.flush();
  }

  private debug(msg: string): void {
    if (this.state.options.debug) {
      console.log(`[ReplayBug] ${msg}`);
    }
  }
}

/**
 * Parse stack frames from error stack
 */
function parseStackFrames(stack: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const lines = stack.split("\n");

  for (const line of lines) {
    const match = line.match(
      /^\s*at\s+(?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|(.+?):(\d+)|(.+))\)?/,
    );
    if (match) {
      const [, fn, file1, line1, col1, file2, line2, file3] = match;
      frames.push({
        function: fn ? sanitizeString(fn) : undefined,
        filename: sanitizeString(file1 || file2 || file3 || ""),
        lineno: parseInt(line1 || line2 || "0", 10) || undefined,
        colno: parseInt(col1 || "0", 10) || undefined,
        in_app: !/(node_modules|webpack|\/vendor\/)/.test(
          file1 || file2 || file3 || "",
        ),
      });
    }
  }

  return frames.slice(0, TELEMETRY_LIMITS.MAX_STACK_FRAMES);
}

/**
 * Singleton instance
 */
let instance: ReplayBug | null = null;

/**
 * Get or create singleton instance
 */
function getInstance(): ReplayBug {
  if (!instance) {
    instance = new ReplayBug();
  }
  return instance;
}

/**
 * Initialize ReplayBug SDK (singleton)
 */
export function init(options: ReplayBugOptions): void {
  getInstance().init(options);
}

/**
 * Capture an exception (singleton)
 */
export function captureException(
  error: Error,
  context?: Record<string, unknown>,
): string {
  return getInstance().captureException(error, context);
}

/**
 * Capture a message (singleton)
 */
export function captureMessage(
  message: string,
  level?: "debug" | "info" | "warning" | "error" | "critical",
  context?: Record<string, unknown>,
): string {
  return getInstance().captureMessage(message, level, context);
}

/**
 * Add a breadcrumb (singleton)
 */
export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp">): void {
  getInstance().addBreadcrumb(breadcrumb);
}

/**
 * Set user (singleton)
 */
export function setUser(user: { id: string } | null): void {
  getInstance().setUser(user);
}

/**
 * Clear user (singleton)
 */
export function clearUser(): void {
  getInstance().clearUser();
}

/**
 * Set tag (singleton)
 */
export function setTag(key: string, value: string): void {
  getInstance().setTag(key, value);
}

/**
 * Set tags (singleton)
 */
export function setTags(tags: Record<string, string>): void {
  getInstance().setTags(tags);
}

/**
 * Set context (singleton)
 */
export function setContext(key: string, value: unknown): void {
  getInstance().setContext(key, value);
}

/**
 * Flush events (singleton)
 */
export function flush(timeoutMs?: number): Promise<void> {
  return getInstance().flush(timeoutMs);
}

/**
 * Close SDK (singleton)
 */
export function close(): Promise<void> {
  return getInstance().close();
}

/**
 * Check if initialized (singleton)
 */
export function isInitialized(): boolean {
  return getInstance().isInitialized();
}

/**
 * Export SDK metadata
 */
export { SDK_VERSION, SDK_NAME, SDK_PROTOCOL_VERSION, PROTOCOL_VERSION };

/**
 * Default export for convenience
 */
export default {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  setUser,
  clearUser,
  setTag,
  setTags,
  setContext,
  flush,
  close,
  isInitialized,
  SDK_VERSION,
  SDK_NAME,
  SDK_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
};
