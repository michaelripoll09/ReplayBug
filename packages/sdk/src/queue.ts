import { TELEMETRY_LIMITS } from "@replaybug/contracts";
import type {
  ClientEvent,
  Transport,
  BatchPayload,
  TransportResult,
} from "./config.js";
import { SDK_NAME, SDK_PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

/**
 * Event queue with batching, flush interval, and retry logic
 */
export interface QueueConfig {
  transport: Transport;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  immediateFlushTypes?: string[];
  debug?: boolean;
  onDebug?: (msg: string) => void;
  /** Retry configuration */
  retry?: Partial<RetryConfig> | undefined;
}

interface ResolvedQueueConfig {
  transport: Transport;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  immediateFlushTypes: string[];
  debug: boolean;
  onDebug: (msg: string) => void;
  retry: RetryConfig;
}

/**
 * Retry configuration for exponential backoff with jitter
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in milliseconds (default: 500) */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 10000) */
  maxDelayMs: number;
  /** Jitter factor (default: 0.2 = 20%) */
  jitterFactor: number;
  /** HTTP status codes that should trigger a retry */
  retryableStatuses: Set<number>;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  jitterFactor: 0.2,
  retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
};

/**
 * Queued event with metadata for retries
 */
interface QueuedEvent {
  event: ClientEvent;
  attempts: number;
  addedAt: number;
}

/**
 * Calculate exponential backoff delay with jitter
 * @param attempt - The current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig,
): number {
  const { baseDelayMs, maxDelayMs, jitterFactor } = config;
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  // Cap at maxDelayMs
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter: ±jitterFactor * cappedDelay
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(cappedDelay + jitter));
}

/**
 * Check if an error/status is retryable
 * @param error - The error or status code
 * @param config - Retry configuration
 * @returns True if retryable
 */
export function isRetryable(error: unknown, config: RetryConfig): boolean {
  // Network errors (no status code) are retryable
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  // Check for status code in error
  const status = (error as { status?: number })?.status;
  if (typeof status === "number" && config.retryableStatuses.has(status)) {
    return true;
  }
  return false;
}

/**
 * Parse Retry-After header value
 * @param retryAfter - The Retry-After header value
 * @returns Delay in milliseconds, or null if invalid
 */
export function parseRetryAfter(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  // Try parsing as seconds (integer)
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // Try parsing as HTTP-date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : null;
  }
  return null;
}

/**
 * In-memory bounded event queue
 */
export class EventQueue {
  private queue: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private closed = false;
  private config: ResolvedQueueConfig;

  constructor(config: QueueConfig) {
    this.config = {
      flushIntervalMs: config.flushIntervalMs ?? 3000,
      maxBatchSize: config.maxBatchSize ?? TELEMETRY_LIMITS.MAX_BATCH_EVENTS,
      maxQueueSize: config.maxQueueSize ?? 1000,
      immediateFlushTypes: config.immediateFlushTypes ?? [
        "exception",
        "unhandled_rejection",
      ],
      debug: config.debug ?? false,
      onDebug: config.onDebug ?? (() => {}),
      transport: config.transport,
      retry: {
        ...DEFAULT_RETRY_CONFIG,
        ...config.retry,
      },
    };
  }

  /**
   * Add event to queue
   */
  enqueue(event: ClientEvent): boolean {
    if (this.closed) {
      this.debug("Queue closed, dropping event");
      return false;
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      // Drop oldest non-critical event
      const dropIndex = this.queue.findIndex(
        (q) => !this.config.immediateFlushTypes.includes(q.event.event_type),
      );
      if (dropIndex >= 0) {
        this.queue.splice(dropIndex, 1);
        this.debug("Queue full, dropped oldest non-critical event");
      } else {
        this.debug("Queue full of critical events, dropping new event");
        return false;
      }
    }

    this.queue.push({ event, attempts: 0, addedAt: Date.now() });
    this.debug(
      `Enqueued ${event.event_type}, queue size: ${this.queue.length}`,
    );

    // Immediate flush for critical events
    if (this.config.immediateFlushTypes.includes(event.event_type)) {
      // Background flush. flush() already logs failures and re-queues the
      // events; swallow the rejection so unattended sends can never surface
      // as unhandled promise rejections in the host application.
      this.flush().catch(() => {});
    } else if (!this.flushTimer) {
      this.scheduleFlush();
    }

    return true;
  }

  /**
   * Schedule periodic flush
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Best-effort background flush: failures are logged and re-queued by
      // flush() itself, so the rejection is swallowed here to avoid
      // unhandled promise rejections from a timer callback.
      this.flush().catch(() => {});
    }, this.config.flushIntervalMs);
  }

  /**
   * Flush queue to transport with exponential backoff retry
   */
  async flush(): Promise<TransportResult | null> {
    if (this.processing || this.queue.length === 0) return null;
    if (this.closed && this.queue.length === 0) return null;

    this.processing = true;
    this.debug(`Flushing ${this.queue.length} events`);

    // Take batch from front of queue
    const batch = this.queue.splice(0, this.config.maxBatchSize);

    try {
      const payload = this.buildBatchPayload(batch.map((q) => q.event));
      const result = await this.sendWithRetry(payload, batch);

      this.debug(
        `Flush result: accepted=${result.accepted}, duplicate=${result.duplicate}, rejected=${result.rejected}`,
      );

      // Handle partial failures - re-queue rejected events for retry
      if (result.rejected > 0) {
        this.debug(`${result.rejected} events rejected by server`);
      }

      return result;
    } catch (error) {
      this.debug(
        `Flush failed after retries: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Re-queue events for retry (with attempt tracking)
      for (const queued of batch.reverse()) {
        queued.attempts += 1;
        if (queued.attempts < this.config.retry.maxAttempts) {
          this.queue.unshift(queued);
        } else {
          this.debug(`Event dropped after ${queued.attempts} attempts`);
        }
      }
      throw error;
    } finally {
      this.processing = false;
      // Schedule next flush if queue not empty
      if (this.queue.length > 0 && !this.flushTimer) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Send payload with exponential backoff retry and Retry-After support
   */
  private async sendWithRetry(
    payload: BatchPayload,
    _batch: QueuedEvent[],
  ): Promise<TransportResult> {
    const { maxAttempts, retryableStatuses } = this.config.retry;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.config.transport.send(payload);
        return result;
      } catch (error) {
        lastError = error;

        // Check if we should retry
        const status = (error as { status?: number })?.status;
        const isRetryableError =
          isRetryable(error, this.config.retry) ||
          (typeof status === "number" && retryableStatuses.has(status));

        if (!isRetryableError || attempt === maxAttempts - 1) {
          throw error;
        }

        // Check for Retry-After header in response
        const response = (
          error as {
            response?: { headers?: { get?: (name: string) => string } };
          }
        )?.response;
        const retryAfterHeader = response?.headers?.get?.("Retry-After");
        const retryAfterDelay = parseRetryAfter(retryAfterHeader || null);

        let delay: number;
        if (retryAfterDelay !== null) {
          // Use Retry-After but cap at maxDelayMs
          delay = Math.min(retryAfterDelay, this.config.retry.maxDelayMs);
          this.debug(
            `Server requested retry after ${delay}ms (Retry-After header)`,
          );
        } else {
          // Exponential backoff with jitter
          delay = calculateRetryDelay(attempt, this.config.retry);
          this.debug(
            `Retry attempt ${attempt + 1}/${maxAttempts} after ${delay}ms (exponential backoff)`,
          );
        }

        // Wait for the delay
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Build batch payload for transport
   */
  private buildBatchPayload(events: ClientEvent[]): BatchPayload {
    // Session metadata would come from state - simplified here
    return {
      protocol_version: SDK_PROTOCOL_VERSION,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      session: {
        sdk_session_id: "placeholder", // Will be replaced by SDK
        browser: {
          name: null,
          version: null,
          os_name: null,
          os_version: null,
          device_type: "unknown",
          viewport_width: null,
          viewport_height: null,
        },
        initial_url: "",
      },
      events,
    };
  }

  /**
   * Close queue and flush remaining events.
   *
   * Each flush attempt is bounded by the remaining shutdown budget so a
   * stalled transport can never make close() hang past the timeout.
   */
  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
      // Small delay to avoid tight loop while the deadline has room left
      if (this.queue.length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    if (this.queue.length > 0) {
      this.debug(`Queue closed with ${this.queue.length} events remaining`);
    }
  }

  /**
   * Get current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  private debug(msg: string): void {
    if (this.config.debug) {
      this.config.onDebug(`[ReplayBug] ${msg}`);
    }
  }
}

/**
 * Create event queue with default configuration
 */
export function createEventQueue(
  transport: Transport,
  options: Partial<QueueConfig> = {},
): EventQueue {
  return new EventQueue({
    transport,
    flushIntervalMs: options.flushIntervalMs ?? 3000,
    maxBatchSize: options.maxBatchSize ?? TELEMETRY_LIMITS.MAX_BATCH_EVENTS,
    maxQueueSize: options.maxQueueSize ?? 1000,
    immediateFlushTypes: options.immediateFlushTypes ?? [
      "exception",
      "unhandled_rejection",
    ],
    debug: options.debug ?? false,
    onDebug: options.onDebug ?? (() => {}),
    retry: options.retry,
  });
}
