import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  aiAnalysisQuery,
  aiCapabilityQuery,
  issueAiAnalysesQuery,
  queryKeys,
  toWorkspaceAuditQuery,
  useInvalidateDomain,
  workspaceAuditQuery,
  workspaceInvitationsQuery,
} from "./queries";

function InvalidationProbe({
  onReady,
}: {
  onReady: (actions: ReturnType<typeof useInvalidateDomain>) => void;
}): React.JSX.Element {
  onReady(useInvalidateDomain());
  return React.createElement("span");
}

describe("workspace governance query factories", () => {
  it("uses targeted invitation and bounded audit query keys", () => {
    expect(workspaceInvitationsQuery("workspace-1").queryKey).toEqual(
      queryKeys.workspaceInvitations("workspace-1"),
    );
    expect(
      workspaceAuditQuery("workspace-1", {
        limit: 500,
        cursor: "cursor-1",
        action: "workspace.updated",
      }).queryKey,
    ).toEqual([
      "workspaces",
      "workspace-1",
      "audit",
      "page",
      "action=workspace.updated&cursor=cursor-1&limit=100",
    ]);
  });

  it("serializes only the generated audit query fields and clamps the limit", () => {
    expect(
      toWorkspaceAuditQuery({
        limit: 0,
        cursor: "cursor-1",
        action: "workspace_member.removed",
      }),
    ).toEqual({
      limit: "1",
      cursor: "cursor-1",
      action: "workspace_member.removed",
    });
    expect(toWorkspaceAuditQuery({ limit: 101 })).toEqual({ limit: "100" });
  });

  it("invalidates governance domains without a global cache sweep", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let actions: ReturnType<typeof useInvalidateDomain> | undefined;
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(InvalidationProbe, {
          onReady: (value: ReturnType<typeof useInvalidateDomain>) => {
            actions = value;
          },
        }),
      ),
    );
    if (actions === undefined) {
      throw new Error("Invalidation probe did not initialize");
    }

    await actions.invalidateWorkspaceInvitations("workspace-1");
    await actions.invalidateWorkspaceAudit("workspace-1");

    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.workspaceInvitations("workspace-1"),
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: queryKeys.workspaceAudit("workspace-1"),
    });
    expect(invalidate).not.toHaveBeenCalledWith({});
  });
});

describe("AI analysis query factories", () => {
  it("keys capability, paginated history and detail without a global key", () => {
    expect(aiCapabilityQuery().queryKey).toEqual(["meta", "ai-analysis"]);
    expect(
      issueAiAnalysesQuery("issue-1", { limit: 25, cursor: "c1" }).queryKey,
    ).toEqual(["issues", "issue-1", "ai-analyses", "cursor=c1&limit=25"]);
    expect(issueAiAnalysesQuery("issue-1", {}).queryKey).toEqual([
      "issues",
      "issue-1",
      "ai-analyses",
      "",
    ]);
    expect(aiAnalysisQuery("analysis-1").queryKey).toEqual([
      "ai-analyses",
      "analysis-1",
    ]);
  });

  it("invalidates only capability, history prefix and one detail", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let actions: ReturnType<typeof useInvalidateDomain> | undefined;
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(InvalidationProbe, {
          onReady: (value: ReturnType<typeof useInvalidateDomain>) => {
            actions = value;
          },
        }),
      ),
    );
    if (actions === undefined) {
      throw new Error("Invalidation probe did not initialize");
    }

    await actions.invalidateAiCapability();
    await actions.invalidateIssueAiAnalyses("issue-1");
    await actions.invalidateAiAnalysis("analysis-1");

    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: queryKeys.aiCapability,
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: ["issues", "issue-1", "ai-analyses"],
    });
    expect(invalidate).toHaveBeenNthCalledWith(3, {
      queryKey: queryKeys.aiAnalysis("analysis-1"),
    });
    expect(invalidate).not.toHaveBeenCalledWith({});
  });
});
