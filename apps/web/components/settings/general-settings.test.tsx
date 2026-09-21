import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const {
  mockDelete,
  mockPatch,
  mockUnwrap,
  mockUseQuery,
  mockInvalidateProject,
  mockPush,
  mockRefresh,
} = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockPatch: vi.fn(),
  mockUnwrap: vi.fn(),
  mockUseQuery: vi.fn(),
  mockInvalidateProject: vi.fn(),
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mockUseQuery }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));
vi.mock("@/lib/api", () => ({
  api: {
    client: { DELETE: mockDelete, PATCH: mockPatch },
    unwrap: mockUnwrap,
  },
}));
vi.mock("@/lib/queries", () => ({
  projectQuery: vi.fn(() => ({ queryKey: ["project", "project-1"] })),
  useInvalidateDomain: () => ({ invalidateProject: mockInvalidateProject }),
}));

import { GeneralSettings } from "./general-settings";

const PROJECT = {
  id: "project-1",
  workspaceId: "workspace-1",
  name: "Project Name",
  slug: "Project-Slug",
  description: "A project",
  timezone: "UTC",
  retentionDays: 30,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function ok<T>(data: T): { data: T; error: undefined; response: Response } {
  return { data, error: undefined, response: new Response() };
}

describe("project general settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({
      data: PROJECT,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });
    mockInvalidateProject.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(ok({ deleted: true }));
  });

  afterEach(() => {
    cleanup();
  });

  it("requires the exact project slug and sends it in the DELETE body", async () => {
    render(<GeneralSettings projectId="project-1" role="owner" />);

    expect(screen.getByLabelText("Retention (days, 7–365)")).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete project…" }));

    const confirmation = screen.getByLabelText("Project slug");
    const deleteButton = screen.getByRole("button", {
      name: "Delete project",
    });
    fireEvent.change(confirmation, { target: { value: PROJECT.name } });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(confirmation, { target: { value: PROJECT.slug } });
    expect(deleteButton).not.toBeDisabled();
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("/api/v1/projects/{id}", {
        params: { path: { id: "project-1" } },
        body: { confirmation: PROJECT.slug },
      });
    });
    expect(mockDelete).not.toHaveBeenCalledWith(
      "/api/v1/projects/{id}",
      expect.objectContaining({
        body: { confirmation: PROJECT.name },
      }),
    );
  });

  it("explains the configured raw retention boundary and longer-lived policy data", () => {
    render(<GeneralSettings projectId="project-1" role="admin" />);

    expect(
      screen.getByText(
        /Raw telemetry and events are retained for this configured period/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Issue aggregates, comments\/activity, reproductions, affected-session lifetime counters, and audit history may remain longer according to policy/,
      ),
    ).toBeInTheDocument();
  });

  it("shows the same retention editor to owner and admin", () => {
    for (const role of ["owner", "admin"] as const) {
      const { unmount } = render(
        <GeneralSettings projectId="project-1" role={role} />,
      );
      expect(
        screen.getByLabelText("Retention (days, 7–365)"),
      ).not.toBeDisabled();
      unmount();
    }
  });
});
