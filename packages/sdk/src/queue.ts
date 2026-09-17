import { TELEMETRY_LIMITS } from "@replaybug/contracts";
import type {
  ClientEvent,
  Transport,
  BatchPayload,
  TransportResult,
} from "./config.js";

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
}

interface ResolvedQueueConfig {
  transport: Transport;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  immediateFlushTypes: string[];
  debug: boolean;
  onDebug: (msg: string) => void;
}

/**
 * Queued event with metadata for retries
 */
interface QueuedEvent {
  event: ClientEvent;
  attempts: number;
  addedAt: number;
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
      this.flush();
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
      this.flush();
    }, this.config.flushIntervalMs);
  }

  /**
   * Flush queue to transport
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
      const result = await this.config.transport.send(payload);

      this.debug(
        `Flush result: accepted=${result.accepted}, duplicate=${result.duplicate}, rejected=${result.rejected}`,
      );

      // Handle partial failures - re-queue rejected events for retry
      if (result.rejected > 0) {
        // For simplicity, we don't track per-event acceptance here
        // In a more sophisticated implementation, the server would return per-event status
        this.debug(`${result.rejected} events rejected by server`);
      }

      return result;
    } catch (error) {
      this.debug(
        `Flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Re-queue events for retry (with attempt tracking)
      for (const queued of batch.reverse()) {
        queued.attempts += 1;
        if (queued.attempts < 3) {
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
   * Build batch payload for transport
   */
  private buildBatchPayload(events: ClientEvent[]): BatchPayload {
    // Session metadata would come from state - simplified here
    return {
      protocol_version: 1,
      sdk_name: "@replaybug/sdk",
      sdk_version: "0.2.0",
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
   * Close queue and flush remaining events
   */
  async close(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const startTime = Date.now();
    while (this.queue.length > 0 && Date.now() - startTime < timeoutMs) {
      await this.flush();
      // Small delay to avoid tight loop
      await new Promise((r) => setTimeout(r, 10));
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
  });
}
