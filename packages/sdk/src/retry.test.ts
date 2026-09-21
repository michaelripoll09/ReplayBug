import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateRetryDelay,
  isRetryable,
  parseRetryAfter,
  createEventQueue,
  DEFAULT_RETRY_CONFIG,
  type RetryConfig,
} from "./queue.js";
import type {
  BatchPayload,
  ClientEvent,
  Transport,
  TransportResult,
} from "./config.js";

function makeClientEvent(eventType = "console_error"): ClientEvent {
  return {
    event_id: "evt-00000000-0000-4000-8000-000000000000",
    sequence_number: 0,
    event_type: eventType,
    timestamp: new Date(0).toISOString(),
    tags: {},
    context: {},
    breadcrumbs: [],
    payload: {},
  };
}

function makeTransport(send: Transport["send"]): Transport {
  return {
    send,
    close: async () => {},
  };
}

function successResult(requestId = "req-1"): TransportResult {
  return { accepted: 1, duplicate: 0, rejected: 0, request_id: requestId };
}

describe("Retry Logic", () => {
  describe("calculateRetryDelay", () => {
    it("calculates exponential backoff correctly", () => {
      const config: RetryConfig = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 10000,
        jitterFactor: 0, // No jitter for deterministic test
        retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
      };

      // attempt 0: 500 * 2^0 = 500
      expect(calculateRetryDelay(0, config)).toBe(500);
      // attempt 1: 500 * 2^1 = 1000
      expect(calculateRetryDelay(1, config)).toBe(1000);
      // attempt 2: 500 * 2^2 = 2000
      expect(calculateRetryDelay(2, config)).toBe(2000);
    });

    it("caps delay at maxDelayMs", () => {
      const config: RetryConfig = {
        maxAttempts: 10,
        baseDelayMs: 500,
        maxDelayMs: 1000,
        jitterFactor: 0,
        retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
      };

      // attempt 2: 500 * 4 = 2000 > 1000, should be capped
      expect(calculateRetryDelay(2, config)).toBe(1000);
      // attempt 10: should still be capped
      expect(calculateRetryDelay(10, config)).toBe(1000);
    });

    it("adds jitter within expected range", () => {
      const config: RetryConfig = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        jitterFactor: 0.2,
        retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
      };

      const delays = new Set<number>();
      for (let i = 0; i < 100; i++) {
        delays.add(calculateRetryDelay(1, config));
      }

      // With 20% jitter, delay should be between 800 and 1200 (base 1000 * 2^1 = 2000)
      // Actually attempt 1: baseDelayMs * 2^1 = 2000, jitter ±20% = 1600-2400
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(1600);
        expect(delay).toBeLessThanOrEqual(2400);
      }
      // Should have some variance due to jitter
      expect(delays.size).toBeGreaterThan(1);
    });

    it("never returns negative delay", () => {
      const config: RetryConfig = {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 10000,
        jitterFactor: 1.0, // 100% jitter
        retryableStatuses: new Set([408, 429, 500, 502, 503, 504]),
      };

      for (let i = 0; i < 100; i++) {
        const delay = calculateRetryDelay(0, config);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("isRetryable", () => {
    const config = DEFAULT_RETRY_CONFIG;

    it("returns true for network errors", () => {
      const networkError = new TypeError("Failed to fetch");
      expect(isRetryable(networkError, config)).toBe(true);
    });

    it("returns true for retryable status codes", () => {
      const error408 = { status: 408 };
      const error429 = { status: 429 };
      const error500 = { status: 500 };
      const error502 = { status: 502 };
      const error503 = { status: 503 };
      const error504 = { status: 504 };

      expect(isRetryable(error408, config)).toBe(true);
      expect(isRetryable(error429, config)).toBe(true);
      expect(isRetryable(error500, config)).toBe(true);
      expect(isRetryable(error502, config)).toBe(true);
      expect(isRetryable(error503, config)).toBe(true);
      expect(isRetryable(error504, config)).toBe(true);
    });

    it("returns false for non-retryable status codes", () => {
      const error400 = { status: 400 };
      const error401 = { status: 401 };
      const error403 = { status: 403 };
      const error404 = { status: 404 };
      const error422 = { status: 422 };

      expect(isRetryable(error400, config)).toBe(false);
      expect(isRetryable(error401, config)).toBe(false);
      expect(isRetryable(error403, config)).toBe(false);
      expect(isRetryable(error404, config)).toBe(false);
      expect(isRetryable(error422, config)).toBe(false);
    });

    it("returns false for generic errors without status", () => {
      const genericError = new Error("Something went wrong");
      expect(isRetryable(genericError, config)).toBe(false);
    });
  });

  describe("parseRetryAfter", () => {
    it("parses seconds correctly", () => {
      expect(parseRetryAfter("5")).toBe(5000);
      expect(parseRetryAfter("0")).toBe(0);
      expect(parseRetryAfter("60")).toBe(60000);
    });

    it("parses HTTP-date correctly", () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString();
      const delay = parseRetryAfter(futureDate);
      expect(delay).not.toBeNull();
      if (delay !== null) {
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    });

    it("returns null for invalid values", () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("")).toBeNull();
      expect(parseRetryAfter("invalid")).toBeNull();
      expect(parseRetryAfter("-1")).toBeNull(); // negative seconds
    });

    it("returns null for past HTTP-date", () => {
      const pastDate = new Date(Date.now() - 10000).toUTCString();
      expect(parseRetryAfter(pastDate)).toBeNull();
    });
  });
});

describe("EventQueue retry behavior (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries up to maxAttempts with exponential delays then rejects", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        throw { status: 500 };
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    const rejection = expect(flushPromise).rejects.toMatchObject({
      status: 500,
    });

    // attempt 0 delay 500ms + attempt 1 delay 1000ms = 1500ms total
    await vi.advanceTimersByTimeAsync(2000);

    await rejection;
    expect(calls).toBe(DEFAULT_RETRY_CONFIG.maxAttempts);
  });

  it("honors Retry-After seconds from a 429 before retrying", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        if (calls === 1) {
          throw {
            status: 429,
            response: {
              headers: {
                get: (name: string) => (name === "Retry-After" ? "2" : null),
              },
            },
          };
        }
        return successResult("req-2");
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // Retry-After says 2000ms; the exponential fallback would have been 500ms.
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(flushPromise).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(2);
  });

  it("honors Retry-After HTTP-date before retrying", async () => {
    vi.useFakeTimers();
    // Pin the clock to a whole-second boundary so the header date, which has
    // second precision, maps back to an exact 3000ms delay.
    vi.setSystemTime(new Date(1_700_000_000_000));
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        if (calls === 1) {
          throw {
            status: 503,
            response: {
              headers: {
                get: (name: string) =>
                  name === "Retry-After"
                    ? new Date(Date.now() + 3000).toUTCString()
                    : null,
              },
            },
          };
        }
        return successResult("req-2");
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(2900);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(flushPromise).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(2);
  });

  it("falls back to exponential backoff for a malformed Retry-After", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        if (calls === 1) {
          throw {
            status: 429,
            response: {
              headers: {
                get: (name: string) =>
                  name === "Retry-After" ? "not-a-delay" : null,
              },
            },
          };
        }
        return successResult("req-2");
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // Exponential attempt 0 with jitter disabled = 500ms
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(2);
    await expect(flushPromise).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(2);
  });

  it("retries network failures and eventually succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        if (calls === 1) {
          throw new TypeError("Failed to fetch");
        }
        return successResult("req-2");
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    await vi.advanceTimersByTimeAsync(500);
    await expect(flushPromise).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(2);
  });

  it("does not retry deterministic 4xx responses", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const queue = createEventQueue(
      makeTransport(async () => {
        calls++;
        throw { status: 401 };
      }),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const flushPromise = queue.flush();
    // A non-retryable status rejects immediately: if the queue tried to
    // retry, no timer would fire here (fake timers are frozen) and the
    // rejection assertion below would time out.
    await expect(flushPromise).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it("close cannot hang when the transport never settles (flush timeout)", async () => {
    vi.useFakeTimers();
    const queue = createEventQueue(
      makeTransport(() => new Promise<TransportResult>(() => {})),
      { retry: { jitterFactor: 0 } },
    );
    queue.enqueue(makeClientEvent());

    const closePromise = queue.close(200);
    const resolution = expect(closePromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);

    await resolution;
  });

  it("close drains pending events when the transport is healthy", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const sentBatches: BatchPayload[] = [];
    const queue = createEventQueue(
      makeTransport(async (batch) => {
        calls++;
        sentBatches.push(batch);
        return successResult("req-drain");
      }),
    );
    queue.enqueue(makeClientEvent());
    queue.enqueue(makeClientEvent());

    const closePromise = queue.close(1000);
    const resolution = expect(closePromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    await resolution;
    expect(calls).toBe(1);
    expect(sentBatches[0]?.events).toHaveLength(2);
  });
});
