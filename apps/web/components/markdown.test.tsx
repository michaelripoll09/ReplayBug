import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { SafeMarkdown } from "./markdown";

/**
 * Synthetic XSS suite (T15 evidence, component level): hostile Markdown
 * must render inert. Browser-level proof lives in Playwright (T17).
 */
describe("SafeMarkdown", () => {
  it("renders formatting while stripping scripts and handlers", () => {
    const { container } = render(
      <SafeMarkdown
        source={
          '**Bold** and <script>alert("xss")</script> and <img src="x" onerror="alert(1)" />'
        }
      />,
    );
    expect(screen.getByText("Bold")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("neutralizes javascript: links", () => {
    const { container } = render(
      <SafeMarkdown source="[click me](javascript:alert(1))" />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    // Sanitizer strips the dangerous href entirely (null) or rewrites it;
    // either way no javascript: URL survives.
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("renders fenced code as inert text", () => {
    render(<SafeMarkdown source={"```html\n<script>alert(2)</script>\n```"} />);
    expect(screen.getByText(/alert\(2\)/)).toBeInTheDocument();
  });
});
