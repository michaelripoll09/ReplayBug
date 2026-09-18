/**
 * Project-scoped SSE helper (Block 6 / T13).
 *
 * Separate from `openapi-fetch`: the browser EventSource API carries the
 * HttpOnly session cookie (`withCredentials`) and receives invalidation
 * hints. Receivers refetch canonical state through TanStack Query —
 * the stream is never a data source.
 */

export type StreamStatus =
  "connecting" | "connected" | "degraded" | "reconnecting" | "closed";

export interface ProjectUpdate {
  version: 1;
  type:
    | "issue.created"
    | "issue.updated"
    | "issue.regressed"
    | "comment.created"
    | "assignment.changed"
    | "tags.changed";
  projectId: string;
  issueId: string;
  eventId?: string;
}

export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener: (
    type: string,
    listener: (event: { data: string }) => void,
  ) => void;
  close: () => void;
}

export interface StreamOptions {
  /** Validated API base: absolute http(s) URL or same-origin path. */
  baseUrl: string;
  /** Project UUID (validated, never interpolated raw). */
  projectId: string;
  onUpdate: (update: ProjectUpdate) => void;
  onStatusChange?: (status: StreamStatus) => void;
  /** Test seam + runtime override; defaults to native EventSource. */
  createEventSource?: (url: string) => EventSourceLike;
}

export interface ProjectEventStream {
  close: () => void;
  getStatus: () => StreamStatus;
}

const KNOWN_TYPES: ReadonlySet<ProjectUpdate["type"]> = new Set([
  "issue.created",
  "issue.updated",
  "issue.regressed",
  "comment.created",
  "assignment.changed",
  "tags.changed",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function normalizeBase(baseUrl: string): string {
  const candidate = baseUrl.trim().replace(/\/+$/, "");
  if (candidate.startsWith("/")) {
    return candidate === "" ? "/" : candidate;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("realtime: baseUrl must be an http(s) URL or a path");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("realtime: baseUrl must be an http(s) URL or a path");
  }
  return candidate;
}

/**
 * Builds the stream URL. Both inputs are validated: only http(s) or
 * same-origin bases, and strictly UUID project ids (no path traversal).
 */
export function buildStreamUrl(baseUrl: string, projectId: string): string {
  if (!UUID_RE.test(projectId)) {
    throw new Error("realtime: projectId must be a UUID");
  }
  const base = normalizeBase(baseUrl);
  const prefix = base === "/" ? "" : base;
  return `${prefix}/api/v1/projects/${encodeURIComponent(projectId)}/events/stream`;
}

/**
 * Parses and validates one `project-update` data payload. Drops anything
 * unexpected (bad JSON, wrong version/type, foreign project, malformed
 * ids) — the caller never sees it.
 */
export function parseProjectUpdate(
  data: string,
  projectId: string,
): ProjectUpdate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1) {
    return null;
  }
  const type = record["type"];
  if (
    typeof type !== "string" ||
    !KNOWN_TYPES.has(type as ProjectUpdate["type"])
  ) {
    return null;
  }
  if (record["projectId"] !== projectId) {
    return null;
  }
  const issueId = record["issueId"];
  if (typeof issueId !== "string" || !UUID_RE.test(issueId)) {
    return null;
  }
  const eventId = record["eventId"];
  if (
    eventId !== undefined &&
    (typeof eventId !== "string" || !UUID_RE.test(eventId))
  ) {
    return null;
  }
  return {
    version: 1,
    type: type as ProjectUpdate["type"],
    projectId,
    issueId,
    ...(eventId !== undefined ? { eventId } : {}),
  };
}

function parseReady(
  text: string,
): { status: string; projectId?: string } | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record["status"] !== "string") {
      return null;
    }
    const projectId = record["projectId"];
    return {
      status: record["status"] as string,
      ...(typeof projectId === "string" ? { projectId } : {}),
    };
  } catch {
    return null;
  }
}

function defaultEventSource(url: string): EventSourceLike {
  const Native =
    typeof EventSource === "function"
      ? (EventSource as unknown as new (
          url: string,
          options?: { withCredentials?: boolean },
        ) => EventSourceLike)
      : null;
  if (Native === null) {
    throw new Error("realtime: EventSource is not available");
  }
  return new Native(url, { withCredentials: true });
}

/**
 * Opens a project update stream with capped-backoff reconnect.
 * Native EventSource auto-retry is suppressed (each error closes the
 * source) so backoff stays deterministic: 1s, 2s, 4s … capped at 30s.
 * `close()` is idempotent and stops all timers and sources.
 */
export function createProjectEventStream(
  options: StreamOptions,
): ProjectEventStream {
  const url = buildStreamUrl(options.baseUrl, options.projectId);
  const createSource = options.createEventSource ?? defaultEventSource;
  let status: StreamStatus = "connecting";
  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let done = false;

  const setStatus = (next: StreamStatus): void => {
    status = next;
    options.onStatusChange?.(next);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const connect = (): void => {
    if (done) {
      return;
    }
    clearTimer();
    setStatus(failures === 0 ? "connecting" : "reconnecting");
    const current = createSource(url);
    source = current;
    // Named server events ("ready", "project-update") dispatch to
    // listeners, NOT to onmessage (which only sees unnamed frames).
    // onmessage stays as a fallback for unnamed data frames.
    const handleData = (text: string): void => {
      if (done || current !== source) {
        return;
      }
      const ready = parseReady(text);
      if (ready !== null && ready.status === "degraded") {
        failures = 0;
        setStatus("degraded");
        return;
      }
      if (ready !== null && ready.status === "connected") {
        failures = 0;
        setStatus("connected");
        return;
      }
      const update = parseProjectUpdate(text, options.projectId);
      if (update !== null) {
        options.onUpdate(update);
      }
    };
    current.onopen = () => {
      // Ready frame upgrades to connected/degraded.
    };
    current.onmessage = (event) => {
      handleData(event.data);
    };
    current.addEventListener("ready", (event) => {
      handleData(event.data);
    });
    current.addEventListener("project-update", (event) => {
      handleData(event.data);
    });
    current.onerror = () => {
      if (done || current !== source) {
        return;
      }
      try {
        current.close();
      } catch {
        // Already torn down.
      }
      if (source === current) {
        source = null;
      }
      failures += 1;
      setStatus("reconnecting");
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** Math.min(failures - 1, 10),
        RECONNECT_MAX_MS,
      );
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };
  };

  connect();

  return {
    close(): void {
      if (done) {
        return;
      }
      done = true;
      clearTimer();
      try {
        source?.close();
      } catch {
        // Already torn down.
      }
      source = null;
      setStatus("closed");
    },
    getStatus(): StreamStatus {
      return status;
    },
  };
}
