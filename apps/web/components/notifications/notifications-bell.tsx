"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import { notificationsQuery, unreadCountQuery } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

export interface BellNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  projectId: string | null;
  issueId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Notification bell with unread badge and popover. Own-user only.
 * Opening the popover refetches; items link to their issue; per-item
 * click marks read, plus an explicit mark-all action.
 */
export function NotificationsBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const unread = useQuery(unreadCountQuery());
  const list = useQuery({
    ...notificationsQuery({ limit: 10 }),
    enabled: open,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }

  const markAll = useMutation({
    mutationFn: async () => {
      const { data, error, response } = await api.client.POST(
        "/api/v1/notifications/read-all",
        {},
      );
      if (error !== undefined || data === undefined) {
        throw await api.unwrap({ data, error, response });
      }
      return data;
    },
    onSuccess: () => void refresh(),
  });

  const markOne = useMutation({
    mutationFn: async (id: string) => {
      const { data, error, response } = await api.client.PATCH(
        "/api/v1/notifications/{id}/read",
        { params: { path: { id } } },
      );
      if (error !== undefined || data === undefined) {
        throw await api.unwrap({ data, error, response });
      }
      return data;
    },
    onSuccess: () => void refresh(),
  });

  const unreadCount = unread.data?.unreadCount ?? 0;
  const items = (list.data?.items ?? []) as BellNotification[];

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={
          unreadCount > 0
            ? `Notifications, ${unreadCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="relative">
          <Bell aria-hidden="true" />
          {unreadCount > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-red-600 font-mono text-[10px] font-bold text-white"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          ) : null}
        </span>
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 max-h-96 w-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-semibold">Notifications</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={markAll.isPending || unreadCount === 0}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          </div>
          {list.isPending ? (
            <p className="px-2 py-4 text-sm text-zinc-500" role="status">
              Loading…
            </p>
          ) : items.length === 0 ? (
            <p className="px-2 py-4 text-sm text-zinc-500">
              You&apos;re all caught up. Assignments and regressions will appear
              here.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={
                      item.issueId !== null && item.projectId !== null
                        ? `/app/projects/${item.projectId}/issues/${item.issueId}`
                        : "#"
                    }
                    onClick={() => {
                      if (item.readAt === null) {
                        markOne.mutate(item.id);
                      }
                      setOpen(false);
                    }}
                    className={cn(
                      "block rounded-md px-2 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      item.readAt === null ? "font-medium" : "text-zinc-500",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 font-mono text-[11px]">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs">
                      {item.body}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
