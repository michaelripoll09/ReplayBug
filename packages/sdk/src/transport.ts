import { TELEMETRY_LIMITS } from "@replaybug/contracts";
import type { Transport, BatchPayload, TransportResult } from "./config.js";

export type { Transport, BatchPayload, TransportResult };

/**
 * Default ingest endpoint path
 */
const INGEST_PATH = "/api/ingest/v1/batch";

/**
 * Fetch-based transport with keepalive support
 */
export class FetchTransport implements Transport {
  private baseUrl: string;
  publicKey: string;
  private debug: boolean;

  constructor(baseUrl: string, publicKey: string, debug: boolean) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.publicKey = publicKey;
    this.debug = debug;
  }

  async send(batch: BatchPayload): Promise<TransportResult> {
    const url = `${this.baseUrl}${INGEST_PATH}`;
    const body = JSON.stringify(batch);
    const bodyBytes = new TextEncoder().encode(body).length;

    // Enforce client-side limits (server also enforces)
    if (batch.events.length > TELEMETRY_LIMITS.MAX_BATCH_EVENTS) {
      throw new Error(
        `Batch exceeds max events: ${batch.events.length} > ${TELEMETRY_LIMITS.MAX_BATCH_EVENTS}`,
      );
    }
    if (bodyBytes > TELEMETRY_LIMITS.MAX_BODY_BYTES) {
      throw new Error(
        `Batch body exceeds max bytes: ${bodyBytes} > ${TELEMETRY_LIMITS.MAX_BODY_BYTES}`,
      );
    }

    for (const event of batch.events) {
      const eventBytes = new TextEncoder().encode(JSON.stringify(event)).length;
      if (eventBytes > TELEMETRY_LIMITS.MAX_EVENT_BYTES) {
        throw new Error(
          `Event exceeds max bytes: ${eventBytes} > ${TELEMETRY_LIMITS.MAX_EVENT_BYTES}`,
        );
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-ReplayBug-Key": this.publicKey,
    };

    // Use keepalive for reliability during unload
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      keepalive: true,
    });

    if (!response.ok) {
      let errorData: unknown;
      try {
        errorData = await response.json();
      } catch {
        errorData = await response.text();
      }
      const error = new Error(
        `Ingest failed: ${response.status} ${response.statusText}`,
      );
      // Attach response for retry logic (includes headers for Retry-After)
      const errorWithResponse = error as Error & {
        status: number;
        response: {
          status: number;
          statusText: string;
          headers: Headers;
          data: unknown;
        };
      };
      errorWithResponse.status = response.status;
      errorWithResponse.response = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: errorData,
      };
      throw errorWithResponse;
    }

    const result = (await response.json()) as TransportResult;
    return result;
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }
}

/**
 * Create transport instance
 */
export function createTransport(
  baseUrl: string,
  publicKey: string,
  debug: boolean,
): Transport {
  return new FetchTransport(baseUrl, publicKey, debug);
}
