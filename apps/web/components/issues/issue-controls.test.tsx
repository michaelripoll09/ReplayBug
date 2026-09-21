import * as React from "react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AssigneeControl, StatusControl, TagsManager } from "./issue-controls";

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}

/**
 * Viewer read-only gating (T14): mutation controls render nothing for
 * viewers; members see labelled controls. Server remains the enforcer.
 */
describe("issue controls gating", () => {
  it("hides status and assignee controls from viewers", () => {
    const { container } = render(
      <StatusControl
        projectId="p"
        issueId="i"
        status="open"
        canMutate={false}
      />,
      { wrapper },
    );
    expect(container).toBeEmptyDOMElement();
    const { container: assignee } = render(
      <AssigneeControl
        projectId="p"
        issueId="i"
        assigneeId={null}
        members={[]}
        canMutate={false}
      />,
      { wrapper },
    );
    expect(assignee).toBeEmptyDOMElement();
  });

  it("shows labelled controls to members", () => {
    render(
      <StatusControl projectId="p" issueId="i" status="open" canMutate />,
      { wrapper },
    );
    expect(screen.getByLabelText("Change issue status")).toBeInTheDocument();
    render(
      <AssigneeControl
        projectId="p"
        issueId="i"
        assigneeId={null}
        members={[{ id: "u", name: "Dev", email: "d@x.io" }]}
        canMutate
      />,
      { wrapper },
    );
    expect(screen.getByLabelText("Assign issue")).toBeInTheDocument();
  });

  it("shows tags read-only to viewers, editable to members", () => {
    const attached = [{ id: "t", name: "Frontend", slug: "frontend" }];
    const { container } = render(
      <TagsManager
        projectId="p"
        issueId="i"
        attached={attached}
        allTags={attached}
        canMutate={false}
      />,
      { wrapper },
    );
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();

    render(
      <TagsManager
        projectId="p"
        issueId="i"
        attached={attached}
        allTags={attached}
        canMutate
      />,
      { wrapper },
    );
    expect(
      screen.getByRole("button", { name: "Remove tag Frontend" }),
    ).toBeInTheDocument();
  });
});
