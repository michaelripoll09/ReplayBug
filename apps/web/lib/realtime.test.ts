import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStreamUrl,
  createProjectEventStream,
  parseProjectUpdate,
  type EventSourceLike,
  type StreamStatus,
} from "./realtime.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost:4001";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  listeners: Record<string, Array<(event: { data: string }) => void>> = {};
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(
    type: string,
    listener: (event: { data: string }) => void,
  ): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }
  close(): void {
    this.closed = true;
  }
  emitOpen(): void {
    this.onopen?.({});
  }
  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
  emitNamed(type: string, data: string): void {
    for (const listener of this.listeners[type] ?? []) {
      listener({ data });
    }
  }
  emitError(): void {
    this.onerror?.({});
  }
}

function updateData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    type: "issue.updated",
    projectId: PROJECT,
    issueId: ISSUE,
    ...overrides,
  });
}

describe("buildStreamUrl", () => {
  it("builds a safe encoded URL for http(s) and same-origin bases", () => {
    expect(buildStreamUrl(BASE, PROJECT)).toBe(
      `http://localhost:4001/api/v1/projects/${PROJECT}/events/stream`,
    );
    expect(buildStreamUrl("/api", PROJECT)).toBe(
      `/api/api/v1/projects/${PROJECT}/events/stream`,
    );
  });

  it("rejects unsafe bases and malformed project ids", () => {
    expect(() => buildStreamUrl("ftp://evil/x", PROJECT)).toThrow();
    expect(() => buildStreamUrl(BASE, "not-a-uuid")).toThrow();
    expect(() => buildStreamUrl(BASE, "../escape")).toThrow();
  });
});

describe("parseProjectUpdate", () => {
  it("accepts versioned updates for the subscribed project", () => {
    expect(parseProjectUpdate(updateData(), PROJECT)).toEqual({
      version: 1,
      type: "issue.updated",
      projectId: PROJECT,
      issueId: ISSUE,
    });
  });

  it("drops foreign, malformed or unknown payloads", () => {
    expect(parseProjectUpdate("not json", PROJECT)).toBeNull();
    expect(
      parseProjectUpdate(updateData({ type: "issue.deleted" }), PROJECT),
    ).toBeNull();
    expect(parseProjectUpdate(updateData({ version: 2 }), PROJECT)).toBeNull();
    expect(
      parseProjectUpdate(updateData({ projectId: ISSUE }), PROJECT),
    ).toBeNull();
    expect(
      parseProjectUpdate(updateData({ issueId: "x" }), PROJECT),
    ).toBeNull();
  });

  it("accepts reproduction updates with a valid reproduction id", () => {
    const reproductionId = "33333333-3333-4333-8333-333333333333";
    expect(
      parseProjectUpdate(
        updateData({ type: "reproduction.ready", reproductionId }),
        PROJECT,
      ),
    ).toEqual({
      version: 1,
      type: "reproduction.ready",
      projectId: PROJECT,
      issueId: ISSUE,
      reproductionId,
    });
    expect(
      parseProjectUpdate(
        updateData({ type: "reproduction.failed", reproductionId }),
        PROJECT,
      ),
    ).toEqual({
      version: 1,
      type: "reproduction.failed",
      projectId: PROJECT,
      issueId: ISSUE,
      reproductionId,
    });
  });

  it("drops reproduction updates with a malformed reproduction id", () => {
    expect(
      parseProjectUpdate(
        updateData({ type: "reproduction.ready", reproductionId: "x" }),
        PROJECT,
      ),
    ).toBeNull();
  });
});

describe("createProjectEventStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connect(
    overrides: {
      onUpdate?: (update: { type: string }) => void;
      onStatusChange?: (status: StreamStatus) => void;
    } = {},
  ): {
    stream: ReturnType<typeof createProjectEventStream>;
    updates: Array<{ type: string }>;
    statuses: StreamStatus[];
  } {
    const updates: Array<{ type: string }> = [];
    const statuses: StreamStatus[] = [];
    const stream = createProjectEventStream({
      baseUrl: BASE,
      projectId: PROJECT,
      onUpdate: (update) => {
        updates.push(update);
        overrides.onUpdate?.(update);
      },
      onStatusChange: (status) => {
        statuses.push(status);
        overrides.onStatusChange?.(status);
      },
      createEventSource: (url) => new FakeEventSource(url),
    });
    return { stream, updates, statuses };
  }

  it("opens a credentialed stream and reports connected on ready", () => {
    const { statuses } = connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe(buildStreamUrl(BASE, PROJECT));

    source?.emitOpen();
    // The server sends NAMED events; the client must listen for them
    // (onmessage alone never fires for named frames — regression guard).
    source?.emitNamed(
      "ready",
      JSON.stringify({ status: "connected", projectId: PROJECT }),
    );
    expect(statuses).toContain("connected");
    expect(statuses[0]).toBe("connecting");
  });

  it("surfaces degraded readiness without dropping the stream", () => {
    const { statuses, updates } = connect();
    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.emitNamed(
      "ready",
      JSON.stringify({ status: "degraded", projectId: PROJECT }),
    );
    expect(statuses).toContain("degraded");
    source?.emitNamed("project-update", updateData());
    expect(updates).toHaveLength(1);
  });

  it("forwards valid updates and drops invalid ones", () => {
    const { updates } = connect();
    const source = FakeEventSource.instances[0];
    source?.emitOpen();
    source?.emitNamed(
      "project-update",
      updateData({ type: "comment.created" }),
    );
    source?.emitNamed("project-update", "garbage");
    source?.emitNamed("project-update", updateData({ type: "nope" }));
    expect(updates.map((u) => u.type)).toEqual(["comment.created"]);
  });

  it("reconnects with capped backoff and stops after close", () => {
    const { stream, statuses } = connect();
    const first = FakeEventSource.instances[0];
    first?.emitOpen();
    first?.emitError();

    expect(statuses).toContain("reconnecting");
    expect(first?.closed).toBe(true);
    // First backoff: 1s — no reconnect yet.
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second failure backs off 2s.
    FakeEventSource.instances[1]?.emitError();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    stream.close();
    expect(FakeEventSource.instances[2]?.closed).toBe(true);
    expect(statuses[statuses.length - 1]).toBe("closed");
    // No further reconnects after close.
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
