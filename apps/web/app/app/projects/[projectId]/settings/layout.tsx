"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { projectQuery, workspaceQuery } from "@/lib/queries";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { SettingsProvider } from "@/components/settings/settings-context";

/** Settings tab shell: loads project + workspace role once, renders tab nav + child. */
export default function SettingsLayout({
  params,
  children,
}: {
  params: Promise<{ projectId: string }>;
  children: React.ReactNode;
}): React.JSX.Element {
  const { projectId } = React.use(params);
  const pathname = usePathname();
  const router = useRouter();
  const project = useQuery(projectQuery(projectId));

  const workspaceId = project.data?.workspaceId;
  const workspace = useQuery({
    ...workspaceQuery(workspaceId ?? "missing"),
    enabled: workspaceId !== undefined,
  });

  if (project.isPending) {
    return (
      <AppShell breadcrumb={<Crumb current>Settings</Crumb>}>
        <RouteSkeleton lines={4} />
      </AppShell>
    );
  }
  if (project.isError || project.data === undefined) {
    return (
      <AppShell breadcrumb={<Crumb current>Settings</Crumb>}>
        <Alert variant="destructive" title="Project unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const role = workspace.data?.role ?? "viewer";
  const active = pathname.endsWith("/environments")
    ? "environments"
    : pathname.endsWith("/origins")
      ? "origins"
      : pathname.endsWith("/keys")
        ? "keys"
        : "general";

  function go(value: string): void {
    if (value === "general") {
      router.push(`/app/projects/${projectId}/settings`);
    } else {
      router.push(`/app/projects/${projectId}/settings/${value}`);
    }
  }

  return (
    <AppShell
      breadcrumb={
        <>
          <Crumb href={`/app/workspaces/${project.data.workspaceId}`}>
            Workspace
          </Crumb>
          <Crumb href={`/app/projects/${projectId}`}>{project.data.name}</Crumb>
          <Crumb current>Settings</Crumb>
        </>
      }
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Project settings
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {project.data.name} · role:{" "}
            <span className="font-medium">{role}</span>
          </p>
        </div>
        <Tabs value={active} onValueChange={go}>
          <TabsList aria-label="Project settings sections">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="environments">Environments</TabsTrigger>
            <TabsTrigger value="origins">Origins</TabsTrigger>
            <TabsTrigger value="keys">Keys &amp; Tokens</TabsTrigger>
          </TabsList>
        </Tabs>
        <div data-testid={`settings-${active}`}>
          <SettingsProvider projectId={projectId} role={role}>
            {children}
          </SettingsProvider>
        </div>
      </div>
    </AppShell>
  );
}
