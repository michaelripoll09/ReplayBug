/**
 * DSN parse result
 */
export interface DsnParseResult {
  publicKey: string;
  baseUrl: string;
  projectId?: string;
}

/**
 * SDK configuration options
 */
export interface ReplayBugOptions {
  /** DSN string: https://<PUBLIC_KEY>@host/api/ingest/v1 */
  dsn: string;
  /** Environment name (e.g., "production", "staging", "development") */
  environment?: string;
  /** Release version (e.g., "web@1.4.2") */
  release?: string;
  /** Enable/disable SDK globally */
  enabled?: boolean;
  /** Enable debug logging */
  debug?: boolean;
  /** Sample rate for general telemetry (0-1) */
  sampleRate?: number;
  /** Maximum breadcrumbs in ring buffer */
  maxBreadcrumbs?: number;
  /** Capture console.error calls */
  captureConsoleErrors?: boolean;
  /** Capture failed network requests */
  captureFailedRequests?: boolean;
  /** Capture click interactions */
  captureClicks?: boolean;
  /** Capture navigation events */
  captureNavigation?: boolean;
  /** Capture safe input interactions (opt-in) */
  captureSafeInputs?: boolean;
  /** CSS selectors for inputs that are safe to capture values from */
  safeInputSelectors?: string[];
  /** URLs to exclude from network capture */
  denyUrls?: string[];
  /** Callback before sending event - can modify or return null to drop */
  beforeSend?: (event: ClientEvent) => ClientEvent | null;
  /** Initial tags */
  tags?: Record<string, string>;
}

/**
 * Default configuration values
 */
export const DEFAULT_OPTIONS: Required<
  Omit<
    ReplayBugOptions,
    "dsn" | "beforeSend" | "tags" | "safeInputSelectors" | "denyUrls"
  >
> & {
  beforeSend: undefined;
  tags: Record<string, string>;
  safeInputSelectors: string[];
  denyUrls: string[];
} = {
  environment: "development",
  release: "unknown",
  enabled: true,
  debug: false,
  sampleRate: 1.0,
  maxBreadcrumbs: 50,
  captureConsoleErrors: false,
  captureFailedRequests: true,
  captureClicks: true,
  captureNavigation: true,
  captureSafeInputs: false,
  safeInputSelectors: [],
  denyUrls: [],
  beforeSend: undefined,
  tags: {},
};

import { BreadcrumbBuffer } from "./breadcrumbs.js";

/**
 * Internal SDK state
 */
export interface SdkState {
  initialized: boolean;
  options: Required<Omit<ReplayBugOptions, "beforeSend">> & {
    beforeSend: ReplayBugOptions["beforeSend"];
  };
  sessionId: string;
  sequence: number;
  breadcrumbs: BreadcrumbBuffer;
  userId: string | null;
  userHash: string | null;
  tags: Record<string, string>;
  context: Record<string, unknown>;
  transport: Transport | null;
  originalConsoleError: typeof console.error | null;
  originalFetch: typeof fetch | null;
  originalXhrOpen: typeof XMLHttpRequest.prototype.open | null;
  originalXhrSend: typeof XMLHttpRequest.prototype.send | null;
  originalPushState: typeof history.pushState | null;
  originalReplaceState: typeof history.replaceState | null;
  popstateHandler: ((event: PopStateEvent) => void) | null;
  clickHandler: ((event: MouseEvent) => void) | null;
  errorHandler: ((event: ErrorEvent) => void) | null;
  rejectionHandler: ((event: PromiseRejectionEvent) => void) | null;
  unloadHandler: (() => void) | null;
}

/**
 * Breadcrumb type (matches contract)
 */
export interface Breadcrumb {
  timestamp: string;
  type:
    "navigation" | "click" | "input" | "network" | "console" | "custom" | "sdk";
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  level: "debug" | "info" | "warning" | "error" | "critical";
  event_type?: string;
  payload?: unknown;
}

/**
 * Client event before serialization
 */
export interface ClientEvent {
  event_id: string;
  sequence_number: number;
  event_type: string;
  timestamp: string;
  tags: Record<string, string>;
  context: Record<string, unknown>;
  breadcrumbs: Breadcrumb[];
  payload: Record<string, unknown>;
}

/**
 * Transport interface
 */
export interface Transport {
  send(batch: BatchPayload): Promise<TransportResult>;
  close(): Promise<void>;
}

/**
 * Batch payload for transport
 */
export interface BatchPayload {
  protocol_version: number;
  sdk_name: string;
  sdk_version: string;
  session: SessionMetadata;
  events: ClientEvent[];
}

/**
 * Session metadata for ingest
 */
export interface SessionMetadata {
  sdk_session_id: string;
  browser: BrowserMetadata;
  initial_url: string;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  user_id?: string | undefined;
}

/**
 * Browser metadata
 */
export interface BrowserMetadata {
  name: string | null;
  version: string | null;
  os_name: string | null;
  os_version: string | null;
  device_type: "desktop" | "mobile" | "tablet" | "unknown";
  viewport_width: number | null;
  viewport_height: number | null;
  user_agent?: string;
}

/**
 * Transport result
 */
export interface TransportResult {
  accepted: number;
  duplicate: number;
  rejected: number;
  request_id: string;
}

/**
 * Parse DSN string
 * Format: https://<PUBLIC_KEY>@host/api/ingest/v1
 *
 * The returned base URL is the origin plus any optional (self-hosted) path
 * prefix. The transport appends the full ingest path, so a DSN that already
 * includes `/api/ingest/v1` is normalized to avoid duplicating the path.
 */
export function parseDsn(dsn: string): DsnParseResult {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    if (!publicKey) {
      throw new Error("DSN missing public key (username)");
    }
    const prefix = url.pathname.replace(/\/api\/ingest\/v1\/?$/, "");
    const baseUrl = (url.origin + prefix).replace(/\/$/, "");
    return { publicKey, baseUrl };
  } catch (error) {
    throw new Error(
      `Invalid DSN: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Web Crypto accessor for identifier generation.
 *
 * Browser-only SDK: uses `globalThis.crypto` (Web Crypto) with no Node-only
 * imports. Fails closed when Web Crypto is unavailable instead of silently
 * falling back to predictable randomness.
 */
function requireWebCrypto(): Crypto {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
    throw new Error(
      "ReplayBug SDK requires Web Crypto (globalThis.crypto.getRandomValues) " +
        "to generate identifiers",
    );
  }
  return webCrypto;
}

/** Renders bytes as lowercase hex (two chars per byte). */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Cryptographically secure random hex string (`length` hex chars). */
function secureRandomHex(length: number): string {
  const byteCount = Math.ceil(length / 2);
  const bytes = new Uint8Array(byteCount);
  requireWebCrypto().getRandomValues(bytes);
  return bytesToHex(bytes).slice(0, length);
}

/**
 * Generate a UUID v4 (for event IDs, session IDs)
 *
 * Prefers `crypto.randomUUID()` when available; otherwise builds a
 * standards-compliant UUID v4 from `crypto.getRandomValues()` with correct
 * version (4) and variant (10xx) bits. Never uses `Math.random()`.
 */
export function generateUuid(): string {
  const webCrypto = requireWebCrypto();
  if (typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Generate session ID (UUID v7-like with timestamp prefix for sortability)
 *
 * Keeps the existing timestamp-prefixed sortable shape; the random section
 * now comes from `crypto.getRandomValues()` (48 bits of secure randomness,
 * matching the previous 12-hex-char width) instead of `Math.random()`.
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const random = secureRandomHex(12).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-4${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6)}`;
}

/**
 * Get current ISO timestamp
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Detect browser metadata
 */
export function getBrowserMetadata(): BrowserMetadata {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return {
      name: null,
      version: null,
      os_name: null,
      os_version: null,
      device_type: "unknown",
      viewport_width: null,
      viewport_height: null,
    };
  }

  const ua = navigator.userAgent;
  let name: string | null = null;
  let version: string | null = null;
  let os_name: string | null = null;
  let os_version: string | null = null;
  let device_type: BrowserMetadata["device_type"] = "desktop";

  // Browser detection
  if (ua.includes("Edg/")) {
    name = "Edge";
    version = ua.split("Edg/")[1]?.split(" ")[0] ?? null;
  } else if (ua.includes("Chrome/") && !ua.includes("Chromium")) {
    name = "Chrome";
    version = ua.split("Chrome/")[1]?.split(" ")[0] ?? null;
  } else if (ua.includes("Firefox/")) {
    name = "Firefox";
    version = ua.split("Firefox/")[1]?.split(" ")[0] ?? null;
  } else if (ua.includes("Safari/") && !ua.includes("Chrome")) {
    name = "Safari";
    const match = ua.match(/Version\/(\d+\.\d+)/);
    version = match?.[1] ?? null;
  } else if (ua.includes("Chromium/")) {
    name = "Chromium";
    version = ua.split("Chromium/")[1]?.split(" ")[0] ?? null;
  }

  // OS detection
  if (ua.includes("Windows NT")) {
    os_name = "Windows";
    const match = ua.match(/Windows NT (\d+\.?\d*)/);
    os_version = match?.[1] ?? null;
  } else if (ua.includes("Mac OS X")) {
    os_name = "macOS";
    const match = ua.match(/Mac OS X (\d+[._]\d+[._]\d+)/);
    os_version = match?.[1]?.replace(/_/g, ".") ?? null;
  } else if (ua.includes("Linux")) {
    os_name = "Linux";
  } else if (ua.includes("Android")) {
    os_name = "Android";
    const match = ua.match(/Android (\d+(\.\d+)?)/);
    os_version = match?.[1] ?? null;
    device_type = "mobile";
  } else if (ua.includes("iPhone") || ua.includes("iPad")) {
    os_name = "iOS";
    const match = ua.match(/OS (\d+[._]\d+[._]\d+)/);
    os_version = match?.[1]?.replace(/_/g, ".") ?? null;
    device_type = ua.includes("iPad") ? "tablet" : "mobile";
  }

  // Viewport
  const viewport_width = window.innerWidth || null;
  const viewport_height = window.innerHeight || null;

  // Refine device type for desktop
  if (
    device_type === "desktop" &&
    viewport_width !== null &&
    viewport_width < 768
  ) {
    device_type = "mobile";
  } else if (
    device_type === "desktop" &&
    viewport_width !== null &&
    viewport_width < 1024
  ) {
    device_type = "tablet";
  }

  return {
    name,
    version,
    os_name,
    os_version,
    device_type,
    viewport_width,
    viewport_height,
    user_agent: ua,
  };
}

/**
 * Sanitize URL for breadcrumbs (uses shared sanitizer)
 */
export { sanitizeUrl } from "./sanitize.js";
