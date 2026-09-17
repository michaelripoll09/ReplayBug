"use client";

import * as React from "react";

/**
 * Onboarding wizard memory. Holds workspace/project ids and the one-time
 * plaintext key in component memory ONLY — never localStorage/sessionStorage/
 * URL/logs/query-cache/console. Gone on unmount/reload by construction.
 */

interface OnboardingState {
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  secret: string | null;
  keyAcknowledged: boolean;
  setWorkspace: (id: string) => void;
  setProject: (id: string, name: string, secret: string) => void;
  acknowledgeKey: () => void;
  clearSecret: () => void;
}

const OnboardingContext = React.createContext<OnboardingState | null>(null);

export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [projectName, setProjectName] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [keyAcknowledged, setKeyAcknowledged] = React.useState(false);

  const value = React.useMemo<OnboardingState>(
    () => ({
      workspaceId,
      projectId,
      projectName,
      secret,
      keyAcknowledged,
      setWorkspace: (id: string) => setWorkspaceId(id),
      setProject: (id: string, name: string, nextSecret: string) => {
        setProjectId(id);
        setProjectName(name);
        setSecret(nextSecret);
        setKeyAcknowledged(false);
      },
      acknowledgeKey: () => setKeyAcknowledged(true),
      clearSecret: () => setSecret(null),
    }),
    [workspaceId, projectId, projectName, secret, keyAcknowledged],
  );
  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingState {
  const ctx = React.useContext(OnboardingContext);
  if (ctx === null) {
    throw new Error("useOnboarding must be used inside OnboardingProvider");
  }
  return ctx;
}
