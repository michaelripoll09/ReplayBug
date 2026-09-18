"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

export interface TimelineEntry {
  id: string;
  sequenceNumber: number;
  eventType: string;
  occurredAt: string;
  environment: string;
  release: string | null;
  pageUrl: string | null;
  summary: string;
}

/**
 * Developer-oriented session timeline: chronological entries with
 * per-type plain-text summaries. The selected occurrence (if any) is
 * highlighted and scannable by more than color (ring + label).
 */
export function SessionTimeline({
  entries,
  highlightEventId,
  linkIssues,
}: {
  entries: TimelineEntry[];
  highlightEventId?: string | null;
  linkIssues?: boolean;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-zinc-500">No events in this window.</p>;
  }
  return (
    <ol className="space-y-1.5">
      {entries.map((entry) => {
        const highlighted =
          highlightEventId !== undefined &&
          highlightEventId !== null &&
          entry.id === highlightEventId;
        return (
          <li
            key={entry.id}
            data-highlighted={highlighted ? "true" : undefined}
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              highlighted
                ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                : "border-zinc-200 dark:border-zinc-800",
            )}
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs text-zinc-500">
                #{entry.sequenceNumber}
              </span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-zinc-800">
                {entry.eventType}
              </span>
              {highlighted ? (
                <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[11px] font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
                  Selected occurrence
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{entry.summary}</span>
              <span
                className="shrink-0 font-mono text-xs text-zinc-500"
                title={entry.occurredAt}
              >
                {formatDateTime(entry.occurredAt)}
              </span>
            </div>
            {entry.pageUrl !== null && entry.pageUrl !== "" ? (
              <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                {entry.pageUrl}
              </p>
            ) : null}
            {linkIssues === true ? (
              <p className="mt-1 text-xs">
                <Link
                  href={`?event=${entry.id}`}
                  className="text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Inspect as occurrence
                </Link>
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
