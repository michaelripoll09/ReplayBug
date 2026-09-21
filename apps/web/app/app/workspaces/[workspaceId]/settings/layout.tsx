"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { workspaceQuery } from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkspaceSettingsProvider } from "@/components/workspace-settings/workspace-settings-context";

const settingTabs = [
  { value: "general", label: "General", suffix: "" },
  { value: "members", label: "Members", suffix: "/members" },
  { value: "invitations", label: "Invitations", suffix: "/invitations" },
  { value: "audit", label: "Audit Log", suffix: "/audit" },
  { value: "danger", label: "Danger Zone", suffix: "/danger" },
] as const;

type WorkspaceSettingTab = (typeof settingTabs)[number]["value"];

export default function WorkspaceSettingsLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>;
  children: React.ReactNode;
}): React.JSX.Element {
  const { workspaceId } = React.use(params);
  const pathname = usePathname();
  const router = useRouter();
  const workspace = useQuery(workspaceQuery(workspaceId));

  if (workspace.isPending) {
    return (
      <AppShell breadcrumb={<Crumb current>Workspace settings</Crumb>}>
        <RouteSkeleton lines={5} />
      </AppShell>
    );
  }
  if (workspace.isError || workspace.data === undefined) {
    return (
      <AppShell breadcrumb={<Crumb current>Workspace settings</Crumb>}>
        <Alert variant="destructive" title="Workspace unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const active =
    settingTabs.find((tab) =>
      tab.suffix === ""
        ? pathname.endsWith("/settings")
        : pathname.endsWith(`/settings${tab.suffix}`),
    )?.value ?? "general";

  function go(value: string): void {
    if (!settingTabs.some((tab) => tab.value === value)) {
      return;
    }
    const tab = settingTabs.find((candidate) => candidate.value === value);
    if (tab === undefined) {
      return;
    }
    router.push(`/app/workspaces/${workspaceId}/settings${tab.suffix}`);
  }

  return (
    <AppShell
      breadcrumb={
        <>
          <Crumb href={`/app/workspaces/${workspaceId}`}>
            {workspace.data.name}
          </Crumb>
          <Crumb current>Settings</Crumb>
        </>
      }
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Workspace settings
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {workspace.data.name} · role: {workspace.data.role}
          </p>
        </div>
        <Tabs value={active satisfies WorkspaceSettingTab} onValueChange={go}>
          <TabsList
            aria-label="Workspace settings sections"
            className="h-auto flex-wrap justify-start"
          >
            {settingTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div data-testid={`workspace-settings-${active}`}>
          <WorkspaceSettingsProvider
            workspaceId={workspaceId}
            workspace={workspace.data}
          >
            {children}
          </WorkspaceSettingsProvider>
        </div>
      </div>
    </AppShell>
  );
}
