"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { workspaceQuery, projectsQuery } from "@/lib/queries";
import { canCreateProject, roleLabel } from "@/lib/rbac";
import { AppShell } from "@/components/app-shell/shell";
import { Crumb } from "@/components/app-shell/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/forms/feedback";
import { ProjectForm } from "@/components/project/project-form";
import { useInvalidateDomain } from "@/lib/queries";
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Workspace overview: real data only — name/role/projects + create if allowed. */
export default function WorkspaceOverview({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}): React.JSX.Element {
  const { workspaceId } = React.use(params);
  const workspace = useQuery(workspaceQuery(workspaceId));
  const projects = useQuery(projectsQuery(workspaceId));
  const { invalidateProjects } = useInvalidateDomain();
  const [dialogOpen, setDialogOpen] = React.useState(false);

  if (workspace.isPending || projects.isPending) {
    return (
      <AppShell breadcrumb={<Crumb current>Workspace</Crumb>}>
        <RouteSkeleton lines={4} />
      </AppShell>
    );
  }
  if (workspace.isError || workspace.data === undefined) {
    return (
      <AppShell breadcrumb={<Crumb current>Workspace</Crumb>}>
        <Alert variant="destructive" title="Workspace unavailable">
          It may have been deleted or you may not have access.
        </Alert>
      </AppShell>
    );
  }

  const ws = workspace.data;
  const canCreate = canCreateProject(ws.role);
  const items = projects.data ?? [];

  return (
    <AppShell
      breadcrumb={
        <>
          <Crumb current>{ws.name}</Crumb>
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{ws.name}</h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="font-mono text-xs">{ws.slug}</span>
              <Badge variant="secondary">{roleLabel(ws.role)}</Badge>
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button asChild type="button" variant="outline" size="sm">
              <Link href={`/app/workspaces/${workspaceId}/settings`}>
                Workspace settings
              </Link>
            </Button>
            {canCreate ? (
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button type="button" size="sm">
                    New project
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>New project in “{ws.name}”</DialogTitle>
                  </DialogHeader>
                  <ProjectForm
                    workspaceId={workspaceId}
                    submitLabel="Create project"
                    onCreated={() => {
                      void invalidateProjects(workspaceId);
                      setDialogOpen(false);
                    }}
                  />
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </div>

        {projects.isError ? (
          <Alert variant="destructive" title="Could not load projects">
            Please try again.
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            title="No projects yet"
            message={
              canCreate
                ? "Create the first project to get a public ingest key."
                : "No projects in this workspace yet. Ask an owner or admin to create one."
            }
            action={
              canCreate ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setDialogOpen(true)}
                >
                  New project
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {items.map((p) => (
              <li
                key={p.id}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <Link
                  href={`/app/projects/${p.id}`}
                  className="font-medium hover:underline"
                >
                  {p.name}
                </Link>
                <p className="mt-1 font-mono text-xs text-zinc-500">{p.slug}</p>
                {p.description != null && p.description.length > 0 ? (
                  <p className="mt-2 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                    {p.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
