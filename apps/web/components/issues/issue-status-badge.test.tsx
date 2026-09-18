import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { IssueStatusBadge } from "./issue-status-badge";

describe("IssueStatusBadge", () => {
  it("names every status in text (never color alone)", () => {
    const cases = [
      ["open", "Open"],
      ["investigating", "Investigating"],
      ["resolved", "Resolved"],
      ["ignored", "Ignored"],
    ] as const;
    for (const [status, label] of cases) {
      const { unmount } = render(<IssueStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it("falls back to Open for unknown statuses", () => {
    render(<IssueStatusBadge status="bogus" />);
    expect(screen.getByText("Open")).toBeInTheDocument();
  });
});
