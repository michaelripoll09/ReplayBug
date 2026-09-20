import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  fallbackFilename,
  filenameFromDisposition,
  IssueExportButton,
} from "./issue-export-button";

const { mockFetch, mockCreateObjectURL, mockRevokeObjectURL } = vi.hoisted(
  () => ({
    mockFetch: vi.fn(),
    mockCreateObjectURL: vi.fn(),
    mockRevokeObjectURL: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({
  getApiBaseUrl: () => "http://localhost:4001",
}));

function jsonResponse(
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify({ secret: "never rendered" }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("IssueExportButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("URL", {
      createObjectURL: mockCreateObjectURL.mockReturnValue("blob:issue-export"),
      revokeObjectURL: mockRevokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    mockFetch.mockResolvedValue(jsonResponse());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requests the API eventId with credentials and uses a safe quoted filename", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        "content-disposition": 'attachment; filename="issue-export.json"',
      }),
    );
    const createElement = vi.spyOn(document, "createElement");

    render(<IssueExportButton issueId="issue-1" eventId="event 1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export issue" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4001/api/v1/issues/issue-1/export?eventId=event%201",
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Export downloaded.",
      );
    });

    const anchor = createElement.mock.results
      .map((result) => (result.type === "return" ? result.value : undefined))
      .find(
        (value): value is HTMLAnchorElement =>
          value instanceof HTMLAnchorElement,
      );
    expect(anchor).toBeDefined();
    expect(anchor?.download).toBe("issue-export.json");
    expect(mockCreateObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:issue-export");
    expect(screen.queryByText("never rendered")).not.toBeInTheDocument();
  });

  it("uses an issue-id-only fallback for missing or unsafe filenames and cleans the Blob URL", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        "content-disposition": 'attachment; filename="../../secret.html"',
      }),
    );
    const createElement = vi.spyOn(document, "createElement");

    render(<IssueExportButton issueId="issue/unsafe" />);
    fireEvent.click(screen.getByRole("button", { name: "Export issue" }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4001/api/v1/issues/issue%2Funsafe/export",
        expect.objectContaining({ credentials: "include" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Export downloaded.",
      );
    });

    const anchor = createElement.mock.results
      .map((result) => (result.type === "return" ? result.value : undefined))
      .find(
        (value): value is HTMLAnchorElement =>
          value instanceof HTMLAnchorElement,
      );
    expect(anchor?.download).toBe(fallbackFilename("issue/unsafe"));
    expect(filenameFromDisposition("attachment; filename=unsafe.json")).toBe(
      null,
    );
    expect(
      filenameFromDisposition('attachment; filename="../../unsafe.json"'),
    ).toBe(null);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:issue-export");
  });

  it("shows an honest error state when the backend rejects the export", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 403 }));

    render(<IssueExportButton issueId="issue-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export issue" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Export failed (403).",
      );
    });
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
  });
});
