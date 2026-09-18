import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProjectRealtime } from "./use-realtime.js";
import type { EventSourceLike } from "./realtime.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";

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
  emitNamed(type: string, data: string): void {
    for (const listener of this.listeners[type] ?? []) {
      listener({ data });
    }
  }
}

function setup(): {
  client: QueryClient;
  wrapper: (props: { children: React.ReactNode }) => React.JSX.Element;
} {
  FakeEventSource.instances = [];
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  void spy;
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe("useProjectRealtime", () => {
  it("opens one stream per project and closes it on unmount", () => {
    const { wrapper } = setup();
    const { result, unmount } = renderHook(
      () =>
        useProjectRealtime(PROJECT, {
          createEventSource: (url) => new FakeEventSource(url),
        }),
      { wrapper },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(result.current).toBe("connecting");

    act(() => {
      FakeEventSource.instances[0]?.onopen?.({});
    });
    unmount();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  it("maps updates to targeted invalidations only", () => {
    const { client, wrapper } = setup();
    const seen: unknown[][] = [];
    vi.spyOn(client, "invalidateQueries").mockImplementation((async (filters: {
      queryKey?: unknown;
    }) => {
      seen.push(filters.queryKey as unknown[]);
    }) as typeof client.invalidateQueries);
    renderHook(
      () =>
        useProjectRealtime(PROJECT, {
          createEventSource: (url) => new FakeEventSource(url),
        }),
      { wrapper },
    );
    const source = FakeEventSource.instances[0];
    act(() => {
      source?.emitNamed(
        "project-update",
        JSON.stringify({
          version: 1,
          type: "comment.created",
          projectId: PROJECT,
          issueId: ISSUE,
        }),
      );
    });
    expect(seen).toContainEqual(["issues", ISSUE, "comments"]);
    expect(seen).toContainEqual(["issues", ISSUE, "activity"]);
    expect(seen).toContainEqual(["issues", ISSUE]);
    // Never a global invalidation without a key.
    for (const key of seen) {
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("stays closed without a project id", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useProjectRealtime(undefined), {
      wrapper,
    });
    expect(result.current).toBe("closed");
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
