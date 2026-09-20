import { Client } from "pg";
import { PROJECT_UPDATES_CHANNEL, type ProjectUpdateType } from "@replaybug/db";

export interface ValidatedProjectUpdate {
  version: 1;
  type: ProjectUpdateType;
  projectId: string;
  issueId: string;
  eventId?: string;
  reproductionId?: string;
  analysisId?: string;
}

export type ProjectUpdateSink = (update: ValidatedProjectUpdate) => void;

export interface BrokerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([
  "issue.created",
  "issue.updated",
  "issue.regressed",
  "comment.created",
  "assignment.changed",
  "tags.changed",
  "reproduction.ready",
  "reproduction.failed",
  "ai_analysis.ready",
  "ai_analysis.failed",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum queued updates per subscriber before coalescing to latest. */
export const MAX_PENDING_PER_SUBSCRIBER = 50;

/** Heartbeat interval for SSE streams (comment frames, no DB traffic). */
export const SSE_HEARTBEAT_MS = 25_000;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Validates a raw LISTEN payload. Anything unexpected (bad JSON, wrong
 * version, unknown type, non-UUID ids) is dropped — never forwarded, never
 * thrown. Only the minimal versioned fields survive; payloads, stacks,
 * comments and secrets cannot pass through because they are never read.
 */
export function validateProjectUpdate(
  raw: unknown,
): ValidatedProjectUpdate | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== 1) {
    return null;
  }
  const type = record["type"];
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    return null;
  }
  const projectId = record["projectId"];
  const issueId = record["issueId"];
  if (!isUuid(projectId) || !isUuid(issueId)) {
    return null;
  }
  const eventId = record["eventId"];
  if (eventId !== undefined && !isUuid(eventId)) {
    return null;
  }
  const reproductionId = record["reproductionId"];
  if (reproductionId !== undefined && !isUuid(reproductionId)) {
    return null;
  }
  const analysisId = record["analysisId"];
  if (analysisId !== undefined && !isUuid(analysisId)) {
    return null;
  }
  return {
    version: 1,
    type: type as ProjectUpdateType,
    projectId,
    issueId,
    ...(eventId !== undefined ? { eventId } : {}),
    ...(reproductionId !== undefined ? { reproductionId } : {}),
    ...(analysisId !== undefined ? { analysisId } : {}),
  };
}

interface Subscriber {
  id: number;
  projectId: string;
  sink: ProjectUpdateSink;
  queue: ValidatedProjectUpdate[];
  flushing: boolean;
  coalesced: number;
}

export interface ProjectUpdatesBroker {
  subscribe: (projectId: string, sink: ProjectUpdateSink) => () => void;
  subscriberCount: (projectId?: string) => number;
  coalescedCount: () => number;
  /**
   * Resolves true once the process LISTEN is established (or immediately
   * when already connected). Never rejects; false means the stream opens
   * degraded (no live updates until the reconnect succeeds — receivers
   * keep working through normal refetch).
   */
  whenReady: (timeoutMs?: number) => Promise<boolean>;
  stop: () => Promise<void>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Process-level PostgreSQL LISTEN broker with in-memory fan-out.
 *
 * Exactly one LISTEN connection per API process subscribes to
 * `replaybug_project_updates`; validated updates fan out to per-project
 * in-memory subscribers (SSE streams). Each API process owns its LISTEN —
 * horizontal scaling adds one cheap LISTEN per process, never shared
 * cursor state.
 *
 * Backpressure: every subscriber has a bounded queue
 * (MAX_PENDING_PER_SUBSCRIBER). Overflow coalesces to the latest update —
 * correct because SSE is an invalidation signal and receivers refetch
 * canonical state. Sinks that throw (dead sockets) are unsubscribed.
 */
export function createProjectUpdatesBroker(options: {
  connectionString: string;
  logger?: BrokerLogger;
}): ProjectUpdatesBroker {
  const logger: BrokerLogger = options.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const subscribers = new Map<string, Set<Subscriber>>();
  let nextId = 1;
  let coalescedTotal = 0;
  let client: Client | null = null;
  let connecting: Promise<void> | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureConnected();
    }, delay);
  }

  function dropClient(reason: string): void {
    if (client !== null) {
      const dead = client;
      client = null;
      dead.removeAllListeners();
      dead.end().catch(() => {});
      logger.warn(`project-updates LISTEN lost (${reason}); reconnecting`);
    }
    scheduleReconnect();
  }

  function handleNotification(message: {
    channel: string;
    payload?: string | undefined;
  }): void {
    if (message.channel !== PROJECT_UPDATES_CHANNEL) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message.payload ?? "null") as unknown;
    } catch {
      logger.warn("project-updates: dropped non-JSON payload");
      return;
    }
    const update = validateProjectUpdate(raw);
    if (update === null) {
      logger.warn("project-updates: dropped invalid payload");
      return;
    }
    const targets = subscribers.get(update.projectId);
    if (targets === undefined || targets.size === 0) {
      return;
    }
    for (const sub of targets) {
      if (sub.queue.length >= MAX_PENDING_PER_SUBSCRIBER) {
        sub.queue.length = 0;
        sub.coalesced += 1;
        coalescedTotal += 1;
      }
      sub.queue.push(update);
      scheduleFlush(sub);
    }
  }

  function scheduleFlush(sub: Subscriber): void {
    if (sub.flushing) {
      return;
    }
    sub.flushing = true;
    setImmediate(() => {
      try {
        let next = sub.queue.shift();
        while (next !== undefined) {
          sub.sink(next);
          next = sub.queue.shift();
        }
      } catch (error) {
        logger.warn(
          `project-updates: unsubscribing failed sink (${String(error)})`,
        );
        removeSubscriber(sub);
      } finally {
        sub.flushing = false;
        if (sub.queue.length > 0) {
          scheduleFlush(sub);
        }
      }
    });
  }

  function removeSubscriber(sub: Subscriber): void {
    const set = subscribers.get(sub.projectId);
    if (set !== undefined) {
      set.delete(sub);
      if (set.size === 0) {
        subscribers.delete(sub.projectId);
      }
    }
    sub.queue.length = 0;
  }

  async function ensureConnected(): Promise<void> {
    if (stopped || client !== null || connecting !== null) {
      return;
    }
    const attempt = (async (): Promise<void> => {
      try {
        const next = new Client({
          connectionString: options.connectionString,
        });
        next.on("notification", handleNotification);
        next.on("error", () => dropClient("connection error"));
        next.on("end", () => {
          if (!stopped && client === next) {
            dropClient("server closed connection");
          }
        });
        await next.connect();
        await next.query(`LISTEN "${PROJECT_UPDATES_CHANNEL}"`);
        if (stopped) {
          await next.end().catch(() => {});
          return;
        }
        client = next;
        reconnectDelayMs = 1000;
        logger.info("project-updates: LISTEN established");
      } catch (error) {
        logger.warn(`project-updates: LISTEN failed (${String(error)})`);
        scheduleReconnect();
      }
    })();
    connecting = attempt;
    try {
      await attempt;
    } finally {
      connecting = null;
    }
  }

  return {
    subscribe(projectId: string, sink: ProjectUpdateSink): () => void {
      const sub: Subscriber = {
        id: nextId++,
        projectId,
        sink,
        queue: [],
        flushing: false,
        coalesced: 0,
      };
      let set = subscribers.get(projectId);
      if (set === undefined) {
        set = new Set();
        subscribers.set(projectId, set);
      }
      set.add(sub);
      void ensureConnected();
      let done = false;
      return () => {
        if (!done) {
          done = true;
          removeSubscriber(sub);
        }
      };
    },
    subscriberCount(projectId?: string): number {
      if (projectId !== undefined) {
        return subscribers.get(projectId)?.size ?? 0;
      }
      let total = 0;
      for (const set of subscribers.values()) {
        total += set.size;
      }
      return total;
    },
    coalescedCount(): number {
      return coalescedTotal;
    },
    async whenReady(timeoutMs = 5000): Promise<boolean> {
      if (client !== null) {
        return true;
      }
      void ensureConnected();
      const start = Date.now();
      while (client === null && !stopped && Date.now() - start < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return client !== null;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      subscribers.clear();
      if (client !== null) {
        const owned = client;
        client = null;
        owned.removeAllListeners();
        await owned.end().catch(() => {});
      }
    },
  };
}
