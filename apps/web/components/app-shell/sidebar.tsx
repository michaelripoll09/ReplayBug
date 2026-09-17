"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Settings, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { meQuery, workspacesQuery, queryKeys } from "@/lib/queries";
import { roleLabel } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { useQueryClient } from "@tanstack/react-query";
import { signOut } from "@/lib/auth-client";

function useActiveWorkspaceId(): string | null {
  const pathname = usePathname();
  const match = pathname.match(/\/app\/workspaces\/([^/]+)/);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  const projectMatch = pathname.match(/\/app\/projects\/([^/]+)/);
  // Project routes don't carry workspaceId in the URL; resolved via project query elsewhere.
  void projectMatch;
  return null;
}

export function WorkspaceSwitcher({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const router = useRouter();
  const { data, isPending, isError } = useQuery(workspacesQuery());
  const activeId = useActiveWorkspaceId();

  if (isPending) {
    return <Skeleton className="h-9 w-full" />;
  }
  if (isError || data === undefined) {
    return (
      <p className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-500 dark:border-zinc-800">
        Workspaces unavailable
      </p>
    );
  }
  if (data.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start"
        onClick={() => {
          onNavigate?.();
          router.push("/onboarding/workspace");
        }}
      >
        <Plus aria-hidden="true" /> New workspace
      </Button>
    );
  }
  const active = data.find((w) => w.id === activeId) ?? data[0];
  return (
    <div className="space-y-2">
      <label
        htmlFor="workspace-switcher"
        className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400"
      >
        Workspace
      </label>
      <div className="flex items-center gap-2">
        <select
          id="workspace-switcher"
          aria-label="Switch workspace"
          className="h-9 flex-1 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          value={active?.id ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            onNavigate?.();
            router.push(`/app/workspaces/${id}`);
          }}
        >
          {data.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <span
          title={
            active !== undefined ? `Role: ${roleLabel(active.role)}` : undefined
          }
        >
          <Badge variant="secondary">
            {active !== undefined ? roleLabel(active.role) : "—"}
          </Badge>
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        onClick={() => {
          onNavigate?.();
          router.push("/onboarding/workspace");
        }}
      >
        <Plus aria-hidden="true" /> New workspace
      </Button>
      <span className="sr-only" aria-hidden="true">
        <ChevronsUpDown />
      </span>
    </div>
  );
}

export function UserArea(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data } = useQuery(meQuery());
  const [pending, setPending] = React.useState(false);

  async function logout(): Promise<void> {
    setPending(true);
    try {
      await signOut();
    } catch {
      // Logout is best-effort; still clear local cache and redirect.
    } finally {
      queryClient.removeQueries({ queryKey: queryKeys.me });
      queryClient.removeQueries({ queryKey: queryKeys.workspaces });
      setPending(false);
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {data?.name ?? data?.email ?? "Account"}
        </p>
        {data?.email !== undefined ? (
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {data.email}
          </p>
        ) : null}
      </div>
      <ThemeToggle />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void logout()}
      >
        {pending ? "Signing out…" : "Log out"}
      </Button>
    </div>
  );
}

export function Sidebar({
  onNavigate,
}: {
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const pathname = usePathname();
  const activeWorkspaceId = useActiveWorkspaceId();
  const overviewHref =
    activeWorkspaceId !== null
      ? `/app/workspaces/${activeWorkspaceId}`
      : "/app";

  return (
    <nav aria-label="Primary" className="flex h-full flex-col gap-6 p-4">
      <Link
        href="/"
        className="flex items-center gap-2 px-1"
        onClick={() => onNavigate?.()}
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-md bg-zinc-900 font-mono text-sm font-bold text-white dark:bg-zinc-50 dark:text-zinc-900"
        >
          R
        </span>
        <span className="text-sm font-semibold tracking-tight">ReplayBug</span>
      </Link>
      <WorkspaceSwitcher onNavigate={onNavigate} />
      <div className="space-y-1">
        <Link
          href={overviewHref}
          onClick={() => onNavigate?.()}
          aria-current={
            pathname.startsWith("/app/workspaces") ||
            pathname.startsWith("/app/projects")
              ? "page"
              : undefined
          }
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800",
            pathname.startsWith("/app")
              ? "bg-zinc-100 dark:bg-zinc-800"
              : undefined,
          )}
        >
          <LayoutDashboard aria-hidden="true" className="size-4" /> Overview
        </Link>
        <p className="px-3 pt-4 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Project
        </p>
        <span className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Settings aria-hidden="true" className="size-4" /> Settings lives
          under each project
        </span>
      </div>
      <div className="mt-auto border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <UserArea />
      </div>
    </nav>
  );
}
