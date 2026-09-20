"use client";

import * as React from "react";
import type { Workspace } from "@/lib/queries";
import type { WorkspaceRole } from "@/lib/rbac";

export interface WorkspaceSettingsContextValue {
  workspaceId: string;
  workspace: Workspace;
  role: WorkspaceRole;
}

const WorkspaceSettingsContext =
  React.createContext<WorkspaceSettingsContextValue | null>(null);

export function WorkspaceSettingsProvider({
  workspaceId,
  workspace,
  children,
}: {
  workspaceId: string;
  workspace: Workspace;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = React.useMemo<WorkspaceSettingsContextValue>(
    () => ({ workspaceId, workspace, role: workspace.role }),
    [workspaceId, workspace],
  );
  return (
    <WorkspaceSettingsContext.Provider value={value}>
      {children}
    </WorkspaceSettingsContext.Provider>
  );
}

export function useWorkspaceSettings(): WorkspaceSettingsContextValue {
  const context = React.useContext(WorkspaceSettingsContext);
  if (context === null) {
    throw new Error(
      "useWorkspaceSettings must be used inside WorkspaceSettingsProvider",
    );
  }
  return context;
}
