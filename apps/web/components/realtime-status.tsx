"use client";

import { useProjectRealtime } from "@/lib/use-realtime";
import { cn } from "@/lib/cn";

/**
 * Honest realtime indicator. SSE is an invalidation signal: "Live" means
 * the stream is open (updates arrive without reload); anything else names
 * the degraded state instead of pretending to be live.
 */
export function RealtimeStatus({ projectId }: { projectId: string }) {
  const status = useProjectRealtime(projectId);
  if (status === "closed") {
    return null;
  }
  return (
    <span
      role="status"
      aria-label={`Realtime updates: ${status}`}
      className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          status === "connected" && "bg-emerald-500",
          status === "degraded" && "bg-amber-500",
          (status === "connecting" || status === "reconnecting") &&
            "animate-pulse bg-zinc-400",
        )}
      />
      {status === "connected"
        ? "Live"
        : status === "degraded"
          ? "Connected (degraded)"
          : status === "reconnecting"
            ? "Reconnecting…"
            : "Connecting…"}
    </span>
  );
}
