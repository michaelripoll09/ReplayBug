import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { SessionTimeline } from "./sessions/session-timeline";
import { IssueStatusBadge } from "./issues/issue-status-badge";

/**
 * Synthetic XSS suite for telemetry text (T15): hostile backend strings
 * must render as inert text. Telemetry arrives raw over the API by design
 * (escaping happens at render); React auto-escaping plus the absence of
 * dangerouslySetInnerHTML is the boundary under test.
 */
describe("telemetry text escaping", () => {
  it("renders hostile titles and summaries as text, never elements", () => {
    const hostile = '<img src="x" onerror="alert(1)">Nice<title>';
    const { container } = render(
      <div>
        <p>{hostile}</p>
        <SessionTimeline
          entries={[
            {
              id: "e1",
              sequenceNumber: 1,
              eventType: "exception",
              occurredAt: "2026-09-18T12:00:00.000Z",
              environment: "production",
              release: null,
              pageUrl: 'https://example.com/?q="><script>alert(2)</script>',
              summary: hostile,
            },
          ]}
        />
      </div>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // Attribute selector only matches real attributes, never escaped text.
    expect(container.querySelector("[onerror]")).toBeNull();
    // The hostile text is visible (escaped), proving text rendering.
    expect(screen.getAllByText(/Nice/).length).toBeGreaterThan(0);
  });

  it("never turns page URLs into links", () => {
    const { container } = render(
      <SessionTimeline
        entries={[
          {
            id: "e1",
            sequenceNumber: 1,
            eventType: "navigation",
            occurredAt: "2026-09-18T12:00:00.000Z",
            environment: "production",
            release: null,
            pageUrl: "javascript:alert(3)",
            summary: "nav",
          },
        ]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("falls back safely on hostile status values", () => {
    const { container } = render(
      <IssueStatusBadge status={'<img src="x" onerror="alert(4)">'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});
