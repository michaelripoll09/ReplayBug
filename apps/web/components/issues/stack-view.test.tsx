import { describe, expect, it, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  StackView,
  symbolicationStatusLabel,
  toStackDiagnostic,
  type ExceptionStackValue,
  type StackDiagnostic,
} from "./stack-view";

// This vitest setup does not enable testing-library auto-cleanup (no
// globals), so unmount explicitly between tests like every other suite here
// must when it renders more than once per file.
afterEach(() => {
  cleanup();
});

const VALUES: ExceptionStackValue[] = [
  {
    type: "TypeError",
    value: "Cannot read properties of null",
    stacktrace: {
      frames: [
        {
          filename: "https://example.com/assets/app.js",
          function: "a",
          lineno: 1,
          colno: 11,
          inApp: true,
        },
      ],
    },
  },
];

const MAPPED: StackDiagnostic = {
  symbolicationStatus: "mapped",
  rawFrames: [
    {
      filename: "https://example.com/assets/app.js",
      function: "a",
      lineno: 1,
      colno: 11,
      inApp: true,
    },
  ],
  mappedFrames: [
    {
      filename: "https://example.com/assets/app.js",
      source: "src/app.ts",
      function: "a",
      name: "onClick",
      line: 10,
      column: 5,
      inApplication: true,
      mapped: true,
    },
  ],
};

/**
 * RS-10 stack evidence: mapped-first default with an explicit toggle, honest
 * raw states, and untrusted source/function names rendered as inert text.
 */
describe("stack view", () => {
  it("defaults to Source mapped when frames are mapped, toggles to Raw", () => {
    render(<StackView values={VALUES} diagnostic={MAPPED} />);
    expect(
      screen.getByRole("button", { name: "Source mapped" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("src/app.ts:10:5 onClick()")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText("https://example.com/assets/app.js:1:11"),
    ).toBeInTheDocument();
  });

  it("renders Raw with an honest status when no map applied", () => {
    const { rerender } = render(
      <StackView values={VALUES} diagnostic={null} />,
    );
    expect(
      screen.queryByRole("button", { name: "Source mapped" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Raw stack trace/)).toBeInTheDocument();
    expect(screen.getByText(/source map unavailable/)).toBeInTheDocument();

    rerender(
      <StackView
        values={VALUES}
        diagnostic={{
          symbolicationStatus: "release_not_found",
          rawFrames: MAPPED.rawFrames,
          mappedFrames: null,
        }}
      />,
    );
    expect(screen.getByText(/release not registered/)).toBeInTheDocument();
  });

  it("labels every persisted symbolication status honestly", () => {
    expect(symbolicationStatusLabel("no_release")).toContain("No release");
    expect(symbolicationStatusLabel("release_not_found")).toContain(
      "not registered",
    );
    expect(symbolicationStatusLabel("map_not_found")).toContain("unavailable");
    expect(symbolicationStatusLabel("invalid_map")).toContain("invalid");
    expect(symbolicationStatusLabel("storage_unavailable")).toContain(
      "storage unavailable",
    );
    expect(symbolicationStatusLabel("partially_mapped")).toContain("Partially");
  });

  it("renders a malicious source name as inert text, never elements", () => {
    const hostile: StackDiagnostic = {
      symbolicationStatus: "mapped",
      rawFrames: [],
      mappedFrames: [
        {
          filename: "https://example.com/assets/app.js",
          source: "</code><script>alert(1)</script>",
          function: "a",
          name: "<img src=x onerror=alert(2)>",
          line: 3,
          column: 4,
          inApplication: true,
          mapped: true,
        },
      ],
    };
    const { container } = render(
      <StackView values={VALUES} diagnostic={hostile} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    // The hostile strings are visible as escaped text (leaf nodes only —
    // ancestor textContent trivially includes them too).
    const hits = screen.getAllByText(
      (_, el) => el?.textContent?.includes("alert(1)") ?? false,
    );
    const leaf = hits.find((el) => el.children.length === 0);
    expect(leaf?.textContent).toContain("alert(1)");
    const nameHits = screen.getAllByText(
      (_, el) => el?.textContent?.includes("alert(2)") ?? false,
    );
    expect(
      nameHits.find((el) => el.children.length === 0)?.textContent,
    ).toContain("alert(2)");
    expect(container.querySelector("[dangerouslySetInnerHTML]")).toBeNull();
  });

  it("renders raw frames without links and escapes hostile filenames", () => {
    const hostileValues: ExceptionStackValue[] = [
      {
        type: "TypeError",
        value: "boom",
        stacktrace: {
          frames: [
            {
              filename: 'javascript:alert(3)"><img src=x>',
              function: "a",
              lineno: 1,
              colno: 1,
              inApp: true,
            },
          ],
        },
      },
    ];
    const { container } = render(
      <StackView values={hostileValues} diagnostic={null} />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("toStackDiagnostic", () => {
  it("returns null for missing or malformed payloads", () => {
    expect(toStackDiagnostic(undefined)).toBeNull();
    expect(toStackDiagnostic(null)).toBeNull();
    expect(toStackDiagnostic({})).toBeNull();
    expect(toStackDiagnostic({ symbolicationStatus: "hacked" })).toBeNull();
  });

  it("keeps allowlisted fields and drops everything else", () => {
    const parsed = toStackDiagnostic({
      symbolicationStatus: "mapped",
      rawFrames: [
        {
          filename: "https://example.com/a.js",
          function: "a",
          lineno: 1,
          colno: 2,
          inApp: true,
          storageKey: "SECRET",
          extra: { nested: true },
        },
      ],
      mappedFrames: [
        {
          filename: "https://example.com/a.js",
          source: "src/a.ts",
          function: "a",
          name: null,
          line: 1,
          column: 2,
          inApplication: true,
          mapped: true,
          contentHash: "SECRET",
        },
      ],
      preferredStack: ["INJECTED"],
      storageKey: "SECRET",
    });
    expect(parsed?.symbolicationStatus).toBe("mapped");
    expect(parsed?.rawFrames).toHaveLength(1);
    expect(parsed?.rawFrames[0]).not.toHaveProperty("storageKey");
    expect(parsed?.mappedFrames?.[0]).not.toHaveProperty("contentHash");
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(JSON.stringify(parsed)).not.toContain("INJECTED");
  });
});
