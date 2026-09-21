"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/** Project sub-navigation: overview, issues, sessions, releases, settings. */
export function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const items = [
    { href: `/app/projects/${projectId}`, label: "Overview", exact: true },
    {
      href: `/app/projects/${projectId}/issues`,
      label: "Issues",
      exact: false,
    },
    {
      href: `/app/projects/${projectId}/sessions`,
      label: "Sessions",
      exact: false,
    },
    {
      href: `/app/projects/${projectId}/releases`,
      label: "Releases",
      exact: false,
    },
    {
      href: `/app/projects/${projectId}/settings`,
      label: "Settings",
      exact: false,
    },
  ];
  return (
    <nav
      aria-label="Project sections"
      className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
    >
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium",
              active
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-50 dark:text-zinc-50"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
