"use client";

import { CheckCircle2, CircleDot, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

export type IssueStatus = "open" | "investigating" | "resolved" | "ignored";

const STATUS_META: Record<
  IssueStatus,
  { label: string; className: string; Icon: typeof CircleDot }
> = {
  open: {
    label: "Open",
    className:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
    Icon: CircleDot,
  },
  investigating: {
    label: "Investigating",
    className:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
    Icon: Eye,
  },
  resolved: {
    label: "Resolved",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    Icon: CheckCircle2,
  },
  ignored: {
    label: "Ignored",
    className:
      "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    Icon: EyeOff,
  },
};

/**
 * Issue status with text label + icon + border treatment. Status is never
 * conveyed by color alone (WCAG: the label text always names the state).
 */
export function IssueStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as IssueStatus] ?? STATUS_META["open"];
  const { Icon } = meta;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {meta.label}
    </span>
  );
}
