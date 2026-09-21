"use client";

import * as React from "react";
import type { WorkspaceRole } from "@/lib/rbac";

const SettingsContext = React.createContext<{
  projectId: string;
  role: WorkspaceRole;
} | null>(null);

export function SettingsProvider({
  projectId,
  role,
  children,
}: {
  projectId: string;
  role: WorkspaceRole;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = React.useMemo(() => ({ projectId, role }), [projectId, role]);
  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): { projectId: string; role: WorkspaceRole } {
  const ctx = React.useContext(SettingsContext);
  if (ctx === null) {
    throw new Error("useSettings must be used inside SettingsProvider");
  }
  return ctx;
}
