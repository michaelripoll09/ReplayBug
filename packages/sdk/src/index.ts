import {
  CUSTOM_FINGERPRINT_MAX_ITEMS,
  CUSTOM_FINGERPRINT_MAX_ITEM_LENGTH,
  PROTOCOL_VERSION,
  TELEMETRY_LIMITS,
} from "@replaybug/contracts";
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
import { parseStackFrames } from "./stackParser.js";
import { setupNetworkCapture } from "./autoCapture.js";
import { setupClickCapture } from "./autoCapture.js";
import { setupNavigationCapture } from "./autoCapture.js";
import { setupInputCapture } from "./autoCapture.js";
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
  private closing: Promise<void> | null = null;

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
      if (this.closing !== null) {
        // A close is in flight. This happens with React StrictMode remounts
        // (effect cleanup closes the SDK, the remounted effect calls init
        // again while close is still settling). Queue the re-initialization
        // after the close completes so the SDK never ends up permanently
        // dead while the host application keeps running.
        this.debug(
          "init() during close: re-initializing after close completes",
        );
        const pending = this.closing;
        void pending
          .catch(() => undefined)
          .then(() => {
            this.init(options);
          });
        return;
      }
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

    // Create queue. The transport is wrapped so every batch carries the real
    // session metadata (the queue itself only knows a static placeholder).
    const sessionTransport: Transport = {
      send: (batch) =>
        this.transport!.send({
          ...batch,
          session: this.buildSessionMetadata(),
        }),
      close: () => this.transport!.close(),
    };

    this.queue = createEventQueue(sessionTransport, {
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

    // Network capture. Error-level failures (>=500, network errors) are sent
    // as first-class network events; client errors (4xx) stay breadcrumb-only.
    if (opts.captureFailedRequests) {
      const cleanup = setupNetworkCapture(this.state, {
        captureFailedRequests: true,
        denyUrls: opts.denyUrls,
        onNetworkEvent: (breadcrumb) => {
          this.addBreadcrumbInternal(breadcrumb);
          if (breadcrumb.level === "error") {
            this.sendEvent(this.createEvent("network", breadcrumb.data ?? {}));
          }
        },
      });
      this.cleanupFns.push(cleanup);
    }

    // Click capture
    if (opts.captureClicks) {
      const cleanup = setupClickCapture(this.state, {
        captureClicks: true,
        onClickEvent: (breadcrumb) => {
          this.addBreadcrumbInternal(breadcrumb);
          this.sendEvent(this.createEvent("click", breadcrumb.data ?? {}));
        },
      });
      this.cleanupFns.push(cleanup);
    }

    // Navigation capture
    if (opts.captureNavigation) {
      const cleanup = setupNavigationCapture(this.state, {
        captureNavigation: true,
        onNavigationEvent: (breadcrumb) => {
          this.addBreadcrumbInternal(breadcrumb);
          this.sendEvent(this.createEvent("navigation", breadcrumb.data ?? {}));
        },
      });
      this.cleanupFns.push(cleanup);
    }

    // Input capture (opt-in). The interaction becomes a first-class event so
    // the persisted timeline can include safe input interactions.
    if (opts.captureSafeInputs) {
      const cleanup = setupInputCapture(this.state, {
        captureSafeInputs: true,
        safeInputSelectors: opts.safeInputSelectors,
        onInputEvent: (breadcrumb) => {
          this.addBreadcrumbInternal(breadcrumb);
          this.sendEvent(this.createEvent("input", breadcrumb.data ?? {}));
        },
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
   *
   * `fingerprint` is an optional developer-supplied grouping override for
   * manual capture only. When provided and usable it becomes the issue
   * fingerprint (within the project namespace); automatic grouping is used
   * otherwise. It is sanitized and bounded before it leaves the browser.
   */
  captureException(
    error: Error,
    context?: Record<string, unknown>,
    fingerprint?: readonly string[],
  ): string {
    const eventId = generateUuid();
    const customFingerprint = normalizeCustomFingerprintInput(fingerprint);
    const payload: Record<string, unknown> = {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: error.stack
            ? { frames: parseSdkStackFrames(error.stack) }
            : undefined,
          mechanism: { type: "generic", handled: true },
        },
      ],
    };
    if (customFingerprint.length > 0) {
      payload["fingerprint"] = customFingerprint;
    }
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
    if (this.closing !== null) {
      // A close is already in flight; await the same promise.
      return this.closing;
    }

    const pending = this.performClose().finally(() => {
      this.closing = null;
    });
    this.closing = pending;
    return pending;
  }

  private async performClose(): Promise<void> {
    // Remove unload handler
    if (this.state.unloadHandler && typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.state.unloadHandler);
    }

    // Flush remaining events (best-effort: a failing drain must never make
    // shutdown throw into the host application).
    try {
      await this.flush(5000);
    } catch (error) {
      this.debug(
        `Final flush failed during close: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

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
      user_id: this.state.userId || undefined,
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
 * Parse stack frames from error stack (linear deterministic parser).
 */
function parseSdkStackFrames(stack: string): Array<Record<string, unknown>> {
  return parseStackFrames(stack, TELEMETRY_LIMITS.MAX_STACK_FRAMES);
}

/**
 * Bounds and sanitizes a custom fingerprint before it is attached to an
 * exception payload. Empty entries are dropped; when nothing usable remains
 * the payload carries no fingerprint and the server uses automatic grouping.
 */
function normalizeCustomFingerprintInput(values?: readonly string[]): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const cleaned: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const bounded = sanitizeString(value)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, CUSTOM_FINGERPRINT_MAX_ITEM_LENGTH);
    if (bounded === "") {
      continue;
    }
    cleaned.push(bounded);
    if (cleaned.length >= CUSTOM_FINGERPRINT_MAX_ITEMS) {
      break;
    }
  }
  return cleaned;
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
 *
 * The optional `fingerprint` overrides automatic grouping for this manual
 * capture. See `ReplayBug.captureException`.
 */
export function captureException(
  error: Error,
  context?: Record<string, unknown>,
  fingerprint?: readonly string[],
): string {
  return getInstance().captureException(error, context, fingerprint);
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
