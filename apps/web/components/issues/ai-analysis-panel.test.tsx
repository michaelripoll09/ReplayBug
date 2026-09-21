import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@replaybug/api-client";
import { AiAnalysisPanel } from "./ai-analysis-panel";
import {
  StackView,
  type ExceptionStackValue,
  type StackDiagnostic,
} from "./stack-view";
import {
  SessionTimeline,
  type TimelineEntry,
} from "@/components/sessions/session-timeline";

const { mockGet, mockPost, mockUnwrap } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockUnwrap: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    client: { GET: mockGet, POST: mockPost },
    unwrap: mockUnwrap,
  },
}));

const ISSUE = "22222222-2222-4222-8222-222222222222";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANALYSIS = "44444444-4444-4444-8444-444444444444";
const ANALYSIS_2 = "55555555-5555-4555-8555-555555555555";
const TIMELINE_ID = "66666666-6666-4666-8666-666666666666";
const NETWORK_ID = "77777777-7777-4777-8777-777777777777";

const DISCLAIMER =
  "AI-generated hypothesis based on captured telemetry. It may be wrong.";

function ok<T>(data: T): { data: T; error: undefined; response: Response } {
  return { data, error: undefined, response: new Response() };
}

interface Capability {
  configured: boolean;
  status: "disabled" | "configured" | "misconfigured";
  model?: string;
}

function historyItem(status: "pending" | "ready" | "failed", id = ANALYSIS) {
  return {
    id,
    eventId: EVENT_A,
    model: "llama3",
    status,
    analysisVersion: "1.0.0",
    requestedBy: { id: "u1", email: "a@b.c", name: "Ada" },
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: status === "pending" ? null : "2026-01-01T00:01:00.000Z",
  };
}

function readyDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: ANALYSIS,
    issueId: ISSUE,
    eventId: EVENT_A,
    model: "llama3",
    status: "ready",
    analysisVersion: "1.0.0",
    requestedBy: { id: "u1", email: "a@b.c", name: "Ada" },
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    summary: "Summary text",
    suspectedCause: "Cause text",
    evidence: [{ ref: "stack:1", reason: "top frame" }],
    reproductionSteps: ["Step one"],
    limitations: ["Limited data"],
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function failedDetail(errorCode: string, errorMessage: string) {
  return {
    ...readyDetail(),
    status: "failed",
    summary: null,
    suspectedCause: null,
    evidence: null,
    reproductionSteps: null,
    limitations: null,
    errorCode,
    errorMessage,
  };
}

let capabilityData: Capability;
let historyItems: unknown[];
let detailData: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  capabilityData = { configured: true, status: "configured", model: "llama3" };
  historyItems = [];
  detailData = null;
  mockGet.mockImplementation((path: string) => {
    if (path === "/api/v1/meta/ai-analysis") {
      return Promise.resolve(ok({ aiAnalysis: capabilityData }));
    }
    if (path === "/api/v1/issues/{issueId}/ai-analyses") {
      return Promise.resolve(ok({ items: historyItems }));
    }
    if (path === "/api/v1/ai-analyses/{id}") {
      return Promise.resolve(ok(detailData));
    }
    return Promise.resolve(ok({}));
  });
  mockPost.mockResolvedValue(
    ok({ id: ANALYSIS, issueId: ISSUE, eventId: EVENT_A, status: "pending" }),
  );
  mockUnwrap.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(
  client: QueryClient,
): ({ children }: { children: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function renderPanel(
  client: QueryClient,
  overrides: Partial<{
    projectId: string;
    issueId: string;
    selectedEventId: string | null | undefined;
    canRequest: boolean;
    isEvidenceRetained: (ref: string) => boolean;
  }> = {},
) {
  const props = {
    projectId: "proj-1",
    issueId: ISSUE,
    selectedEventId: EVENT_A,
    canRequest: true,
    ...overrides,
  };
  return render(React.createElement(AiAnalysisPanel, props), {
    wrapper: wrapper(client),
  });
}

/**
 * Click a real anchor while cancelling jsdom's deferred navigation. jsdom's
 * activation behavior runs only when the event is not canceled, so a
 * capture-phase `preventDefault` silences the noisy "Not implemented:
 * navigation" error while the element's React `onClick` still fires.
 */
function clickLink(link: HTMLElement): void {
  const cancel = (event: Event): void => event.preventDefault();
  document.addEventListener("click", cancel, { capture: true, once: true });
  try {
    fireEvent.click(link);
  } finally {
    document.removeEventListener("click", cancel, { capture: true });
  }
}

describe("AiAnalysisPanel capability and request binding", () => {
  it("binds the request to the currently selected occurrence and mints a new key per click", async () => {
    const client = makeClient();
    const { rerender } = renderPanel(client, { selectedEventId: EVENT_A });
    const button = await screen.findByRole("button", {
      name: "Analyze with local AI",
    });

    fireEvent.click(button);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

    // Change the selected occurrence; the next request must follow it.
    rerender(
      React.createElement(AiAnalysisPanel, {
        projectId: "proj-1",
        issueId: ISSUE,
        selectedEventId: EVENT_B,
        canRequest: true,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Analyze with local AI" }),
    );
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));

    const first = mockPost.mock.calls[0] as [
      string,
      {
        params: { path: { eventId: string } };
        headers: Record<string, string>;
      },
    ];
    const second = mockPost.mock.calls[1] as [
      string,
      {
        params: { path: { eventId: string } };
        headers: Record<string, string>;
      },
    ];
    expect(first[0]).toBe("/api/v1/events/{eventId}/ai-analyses");
    expect(first[1].params.path.eventId).toBe(EVENT_A);
    expect(second[1].params.path.eventId).toBe(EVENT_B);
    expect(first[1].headers["Idempotency-Key"]).toBeTruthy();
    expect(second[1].headers["Idempotency-Key"]).not.toBe(
      first[1].headers["Idempotency-Key"],
    );
  });

  it("shows a safe disabled state without a request control", async () => {
    capabilityData = { configured: false, status: "disabled" };
    const client = makeClient();
    renderPanel(client);
    expect(
      await screen.findByText("Local AI analysis is not configured."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Core ReplayBug functionality does not require AI."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
  });

  it("reports AI_NOT_CONFIGURED as a safe state, not a raw error", async () => {
    const client = makeClient();
    mockPost.mockResolvedValue({
      data: undefined,
      error: { code: "AI_NOT_CONFIGURED" },
      response: new Response(),
    });
    mockUnwrap.mockRejectedValue(
      new ApiError({
        code: "AI_NOT_CONFIGURED",
        message: "AI not configured",
        status: 503,
        requestId: "req-1",
      }),
    );
    renderPanel(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "Analyze with local AI" }),
    );
    expect(
      await screen.findByText(/Configure Ollama to use this optional feature/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Core ReplayBug functionality does not require AI/),
    ).toBeInTheDocument();
  });

  it("invalidates only the issue history and activity after a request", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderPanel(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "Analyze with local AI" }),
    );
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["issues", ISSUE, "ai-analyses"],
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["issues", ISSUE, "activity"],
    });
    expect(invalidate).not.toHaveBeenCalledWith({});
  });

  it("offers no request control when no retained occurrence is selected", async () => {
    const client = makeClient();
    renderPanel(client, { selectedEventId: null });
    expect(
      await screen.findByText(/Select a retained occurrence to analyze/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
  });

  it("reuses the same idempotency key only for an explicit transport retry", async () => {
    const client = makeClient();
    mockPost.mockResolvedValueOnce({
      data: undefined,
      error: { code: "INTERNAL_ERROR" },
      response: new Response(),
    });
    mockUnwrap.mockRejectedValueOnce(
      new ApiError({
        code: "INTERNAL_ERROR",
        message: "boom",
        status: 500,
        requestId: "req-1",
      }),
    );
    renderPanel(client);
    fireEvent.click(
      await screen.findByRole("button", { name: "Analyze with local AI" }),
    );
    const retry = await screen.findByRole("button", {
      name: "Retry with the same request",
    });
    const firstKey = (
      mockPost.mock.calls[0] as [string, { headers: Record<string, string> }]
    )[1].headers["Idempotency-Key"];

    mockPost.mockResolvedValueOnce(
      ok({ id: ANALYSIS, issueId: ISSUE, eventId: EVENT_A, status: "pending" }),
    );
    fireEvent.click(retry);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    const secondKey = (
      mockPost.mock.calls[1] as [string, { headers: Record<string, string> }]
    )[1].headers["Idempotency-Key"];
    expect(secondKey).toBe(firstKey);
  });
});

describe("AiAnalysisPanel read-only viewer", () => {
  it("hides request and retry controls but keeps history and detail readable", async () => {
    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail("AI_ANALYSIS_TIMEOUT", "internal stack");
    const client = makeClient();
    renderPanel(client, { canRequest: false });

    expect(
      await screen.findByText("The local model timed out"),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot request new analyses/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
    // Read-only history remains visible.
    expect(screen.getByText("History (1)")).toBeInTheDocument();
  });
});

describe("AiAnalysisPanel degraded-capability retry gating", () => {
  it("hides every retry control and keeps the disabled copy when capability is disabled", async () => {
    capabilityData = { configured: false, status: "disabled" };
    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail("AI_ANALYSIS_TIMEOUT", "internal stack");
    const client = makeClient();
    renderPanel(client);

    // Wait for the failed detail to render so the retry decision is final.
    expect(
      await screen.findByText("The local model timed out"),
    ).toBeInTheDocument();
    // The mandatory disabled copy stays visible.
    expect(
      screen.getByText("Local AI analysis is not configured."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Core ReplayBug functionality does not require AI."),
    ).toBeInTheDocument();
    // No dead-end control may offer a request that can only 503.
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("hides every retry control when capability is misconfigured", async () => {
    capabilityData = { configured: false, status: "misconfigured" };
    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail("AI_ANALYSIS_PROVIDER_UNAVAILABLE", "down");
    const client = makeClient();
    renderPanel(client);

    expect(await screen.findByText("Ollama unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Local AI analysis is not configured."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("still offers retry for a reachable-but-failed attempt when capability is configured", async () => {
    capabilityData = {
      configured: true,
      status: "configured",
      model: "llama3",
    };
    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail("AI_ANALYSIS_PROVIDER_UNAVAILABLE", "down");
    const client = makeClient();
    renderPanel(client);

    expect(await screen.findByText("Ollama unavailable")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Analyze again" }).length,
    ).toBeGreaterThan(0);
  });
});

describe("AiAnalysisPanel ready detail", () => {
  it("renders the exact visible hypothesis disclaimer with all sections", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail();
    const client = makeClient();
    renderPanel(client);

    expect(await screen.findByText(DISCLAIMER)).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Suspected cause")).toBeInTheDocument();
    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("Suggested steps")).toBeInTheDocument();
    expect(screen.getByText("Limitations")).toBeInTheDocument();
    expect(screen.getByText("Summary text")).toBeInTheDocument();
    expect(screen.getByText("Cause text")).toBeInTheDocument();
    expect(screen.getByText("Step one")).toBeInTheDocument();
    expect(screen.getByText("Limited data")).toBeInTheDocument();
  });

  it("renders hostile model text inertly", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      summary: "<script>alert(1)</script>",
      suspectedCause: '<img src=x onerror="alert(2)">',
      reproductionSteps: [
        "javascript:alert(3)",
        "[click me](javascript:alert(4))",
      ],
      limitations: ['<a href="https://evil.example">link</a>'],
      evidence: [
        { ref: "<img src=x onerror=alert(5)>", reason: "<b>bold</b>" },
        { ref: "timeline:" + TIMELINE_ID, reason: "<script>x</script>" },
      ],
    });
    const client = makeClient();
    const { container } = renderPanel(client);

    await screen.findByText(DISCLAIMER);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    // The hostile strings are visible as escaped text.
    expect(container.textContent).toContain("alert(1)");
    expect(container.textContent).toContain("alert(2)");
    expect(container.textContent).toContain("javascript:alert(3)");
  });
});

describe("AiAnalysisPanel evidence navigation", () => {
  it("links retained timeline/network refs and flags removed evidence", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [
        { ref: "stack:1", reason: "top frame" },
        { ref: `timeline:${TIMELINE_ID}`, reason: "preceding event" },
        { ref: `network:${NETWORK_ID}`, reason: "failed request" },
        {
          ref: "timeline:99999999-9999-4999-8999-999999999999",
          reason: "gone",
        },
      ],
    });
    const client = makeClient();
    renderPanel(client, {
      isEvidenceRetained: (ref) =>
        ref === "stack:1" || ref === `timeline:${TIMELINE_ID}`,
    });

    await screen.findByText(DISCLAIMER);
    expect(
      screen.getByRole("button", { name: "Highlight frame 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View timeline event" }),
    ).toHaveAttribute(
      "href",
      `/app/projects/proj-1/issues/${ISSUE}?event=${TIMELINE_ID}`,
    );
    expect(
      screen.queryByRole("link", { name: "View network event" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Evidence no longer retained")).toHaveLength(2);
  });

  it("scrolls and highlights the mapped frame for a stack ref", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [{ ref: "stack:2", reason: "second frame" }],
    });
    const frame = document.createElement("div");
    frame.setAttribute("data-stack-frame-index", "2");
    document.body.appendChild(frame);
    try {
      const client = makeClient();
      renderPanel(client, { isEvidenceRetained: () => true });
      const button = await screen.findByRole("button", {
        name: "Highlight frame 2",
      });
      fireEvent.click(button);
      expect(frame.getAttribute("data-ai-highlight")).toBe("true");
    } finally {
      frame.remove();
    }
  });

  // The two precision tests below render the real StackView/SessionTimeline
  // components next to the panel and assert the reveal lands on the exact
  // `stack:N` frame element and the exact `timeline:`/`network:` entry
  // element — not merely the enclosing section.
  it("highlights the exact rendered mapped frame element for a stack ref", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [{ ref: "stack:2", reason: "second frame" }],
    });
    const values: ExceptionStackValue[] = [
      {
        type: "TypeError",
        value: "boom",
        stacktrace: {
          frames: [
            {
              filename: "https://example.com/assets/app.js",
              function: "first",
              lineno: 1,
              colno: 1,
              inApp: true,
            },
            {
              filename: "https://example.com/assets/app.js",
              function: "second",
              lineno: 2,
              colno: 2,
              inApp: true,
            },
          ],
        },
      },
    ];
    const diagnostic: StackDiagnostic = {
      symbolicationStatus: "mapped",
      rawFrames: [
        {
          filename: "https://example.com/assets/app.js",
          function: "first",
          lineno: 1,
          colno: 1,
          inApp: true,
        },
        {
          filename: "https://example.com/assets/app.js",
          function: "second",
          lineno: 2,
          colno: 2,
          inApp: true,
        },
      ],
      mappedFrames: [
        {
          filename: "https://example.com/assets/app.js",
          source: "src/first.ts",
          function: "first",
          name: "first",
          line: 10,
          column: 1,
          inApplication: true,
          mapped: true,
        },
        {
          filename: "https://example.com/assets/app.js",
          source: "src/second.ts",
          function: "second",
          name: "second",
          line: 20,
          column: 2,
          inApplication: true,
          mapped: true,
        },
      ],
    };
    const client = makeClient();
    const { container } = render(
      <>
        {React.createElement(AiAnalysisPanel, {
          projectId: "proj-1",
          issueId: ISSUE,
          selectedEventId: EVENT_A,
          canRequest: true,
        })}
        <StackView values={values} diagnostic={diagnostic} />
      </>,
      { wrapper: wrapper(client) },
    );

    const button = await screen.findByRole("button", {
      name: "Highlight frame 2",
    });
    const frameOne = container.querySelector('[data-stack-frame-index="1"]');
    const frameTwo = container.querySelector('[data-stack-frame-index="2"]');
    expect(frameOne).not.toBeNull();
    expect(frameTwo).not.toBeNull();
    expect(frameTwo?.textContent).toContain("src/second.ts");

    fireEvent.click(button);
    expect(frameTwo).toHaveAttribute("data-ai-highlight", "true");
    expect(frameOne).not.toHaveAttribute("data-ai-highlight");
  });

  it("highlights the exact rendered raw frame element when no map applied", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [{ ref: "stack:2", reason: "second raw frame" }],
    });
    const values: ExceptionStackValue[] = [
      { type: "TypeError", value: "boom" },
    ];
    const diagnostic: StackDiagnostic = {
      symbolicationStatus: "map_not_found",
      rawFrames: [
        {
          filename: "https://example.com/assets/a.js",
          function: "first",
          lineno: 1,
          colno: 1,
          inApp: true,
        },
        {
          filename: "https://example.com/assets/b.js",
          function: "second",
          lineno: 2,
          colno: 2,
          inApp: true,
        },
      ],
      mappedFrames: null,
    };
    const client = makeClient();
    const { container } = render(
      <>
        {React.createElement(AiAnalysisPanel, {
          projectId: "proj-1",
          issueId: ISSUE,
          selectedEventId: EVENT_A,
          canRequest: true,
        })}
        <StackView values={values} diagnostic={diagnostic} />
      </>,
      { wrapper: wrapper(client) },
    );

    const button = await screen.findByRole("button", {
      name: "Highlight frame 2",
    });
    const frameOne = container.querySelector('[data-stack-frame-index="1"]');
    const frameTwo = container.querySelector('[data-stack-frame-index="2"]');
    expect(frameOne).not.toBeNull();
    expect(frameTwo).not.toBeNull();
    expect(frameTwo?.textContent).toContain("https://example.com/assets/b.js");

    fireEvent.click(button);
    expect(frameTwo).toHaveAttribute("data-ai-highlight", "true");
    expect(frameOne).not.toHaveAttribute("data-ai-highlight");
  });

  it("exposes frame anchors on the stacktrace fallback when no diagnostic is persisted", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [{ ref: "stack:2", reason: "second fallback frame" }],
    });
    const values: ExceptionStackValue[] = [
      {
        type: "TypeError",
        value: "boom",
        stacktrace: {
          frames: [
            {
              filename: "https://example.com/assets/a.js",
              function: "first",
              lineno: 1,
              colno: 1,
              inApp: true,
            },
            {
              filename: "https://example.com/assets/b.js",
              function: "second",
              lineno: 2,
              colno: 2,
              inApp: true,
            },
          ],
        },
      },
    ];
    const client = makeClient();
    const { container } = render(
      <>
        {React.createElement(AiAnalysisPanel, {
          projectId: "proj-1",
          issueId: ISSUE,
          selectedEventId: EVENT_A,
          canRequest: true,
        })}
        <StackView values={values} diagnostic={null} />
      </>,
      { wrapper: wrapper(client) },
    );

    const button = await screen.findByRole("button", {
      name: "Highlight frame 2",
    });
    const frameOne = container.querySelector('[data-stack-frame-index="1"]');
    const frameTwo = container.querySelector('[data-stack-frame-index="2"]');
    expect(frameOne).not.toBeNull();
    expect(frameTwo).not.toBeNull();
    expect(frameTwo?.textContent).toContain("https://example.com/assets/b.js");

    fireEvent.click(button);
    expect(frameTwo).toHaveAttribute("data-ai-highlight", "true");
    expect(frameOne).not.toHaveAttribute("data-ai-highlight");
  });

  it("highlights the exact rendered timeline and network entries for event refs", async () => {
    historyItems = [historyItem("ready", ANALYSIS)];
    detailData = readyDetail({
      evidence: [
        { ref: `timeline:${TIMELINE_ID}`, reason: "preceding event" },
        { ref: `network:${NETWORK_ID}`, reason: "failed request" },
      ],
    });
    const entries: TimelineEntry[] = [
      {
        id: "00000000-0000-4000-8000-000000000000",
        sequenceNumber: 1,
        eventType: "click",
        occurredAt: "2026-01-01T00:00:00.000Z",
        environment: "production",
        release: null,
        pageUrl: "https://example.com/",
        summary: "first entry",
      },
      {
        id: TIMELINE_ID,
        sequenceNumber: 2,
        eventType: "navigation",
        occurredAt: "2026-01-01T00:00:01.000Z",
        environment: "production",
        release: null,
        pageUrl: null,
        summary: "second entry",
      },
      {
        id: NETWORK_ID,
        sequenceNumber: 3,
        eventType: "network",
        occurredAt: "2026-01-01T00:00:02.000Z",
        environment: "production",
        release: null,
        pageUrl: null,
        summary: "third entry",
      },
    ];
    const client = makeClient();
    const { container } = render(
      <>
        {React.createElement(AiAnalysisPanel, {
          projectId: "proj-1",
          issueId: ISSUE,
          selectedEventId: EVENT_A,
          canRequest: true,
        })}
        <SessionTimeline entries={entries} />
      </>,
      { wrapper: wrapper(client) },
    );

    const timelineLink = await screen.findByRole("link", {
      name: "View timeline event",
    });
    clickLink(timelineLink);

    const timelineEntry = container.querySelector(
      `[data-timeline-event-id="${TIMELINE_ID}"]`,
    );
    const otherEntry = container.querySelector(
      `[data-timeline-event-id="${NETWORK_ID}"]`,
    );
    expect(timelineEntry).not.toBeNull();
    expect(otherEntry).not.toBeNull();
    expect(timelineEntry).toHaveAttribute("data-ai-highlight", "true");
    expect(otherEntry).not.toHaveAttribute("data-ai-highlight");

    const networkLink = screen.getByRole("link", {
      name: "View network event",
    });
    clickLink(networkLink);
    expect(otherEntry).toHaveAttribute("data-ai-highlight", "true");
  });
});

describe("AiAnalysisPanel failure states", () => {
  it("maps failure codes to safe copy and never shows the raw message", async () => {
    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail(
      "AI_ANALYSIS_PROVIDER_UNAVAILABLE",
      "http://ollama.internal:11434/stack/trace",
    );
    const client = makeClient();
    const { container } = renderPanel(client);
    expect(await screen.findByText("Ollama unavailable")).toBeInTheDocument();
    expect(container.textContent).not.toContain("ollama.internal");
    expect(container.textContent).not.toContain("stack/trace");
  });

  it("maps invalid model responses and pending states", async () => {
    historyItems = [historyItem("pending", ANALYSIS_2)];
    detailData = {
      ...historyItem("pending", ANALYSIS_2),
      issueId: ISSUE,
      summary: null,
      suspectedCause: null,
      evidence: null,
      reproductionSteps: null,
      limitations: null,
      errorCode: null,
      errorMessage: null,
    };
    const pendingClient = makeClient();
    const { unmount } = renderPanel(pendingClient);
    await waitFor(() =>
      expect(
        screen.getAllByText("Analyzing with local Ollama…").length,
      ).toBeGreaterThan(0),
    );
    unmount();

    historyItems = [historyItem("failed", ANALYSIS)];
    detailData = failedDetail("AI_ANALYSIS_RESPONSE_INVALID", "bad json");
    const invalidClient = makeClient();
    renderPanel(invalidClient);
    expect(
      await screen.findByText("Invalid model response"),
    ).toBeInTheDocument();
  });
});
