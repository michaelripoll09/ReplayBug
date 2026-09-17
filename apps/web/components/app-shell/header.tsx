"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sidebar } from "./sidebar";

/** Compact header: breadcrumb (URL is source of truth) + actions + mobile drawer. */
export function Header({
  breadcrumb,
}: {
  breadcrumb: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  // Close the drawer on navigation.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="flex h-14 items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu aria-hidden="true" />
      </Button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 truncate text-sm">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link
              href="/"
              className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              ReplayBug
            </Link>
          </li>
          {breadcrumb}
        </ol>
      </nav>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-label="Navigation"
          className="max-h-[85vh] overflow-y-auto"
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <Sidebar onNavigate={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </header>
  );
}

export function Crumb({
  href,
  children,
  current,
}: {
  href?: string;
  children: React.ReactNode;
  current?: boolean;
}): React.JSX.Element {
  return (
    <>
      <li aria-hidden="true" className="text-zinc-400">
        /
      </li>
      <li>
        {current === true || href === undefined ? (
          <span aria-current="page" className="font-medium">
            {children}
          </span>
        ) : (
          <Link
            href={href}
            className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            {children}
          </Link>
        )}
      </li>
    </>
  );
}
