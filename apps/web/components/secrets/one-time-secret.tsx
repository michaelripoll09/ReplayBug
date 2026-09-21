"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Copy, Check, Eye, EyeOff } from "lucide-react";

/**
 * One-time secret display (public ingest key plaintext).
 *
 * Security contract:
 * - The secret lives in component memory ONLY (React state passed as prop).
 * - Never written to localStorage/sessionStorage/URL/logs/query cache/console.
 * - Hidden by default, explicit reveal, copy via clipboard, monospace.
 * - Gone on unmount/reload (parent must drop the value on navigation).
 */
export function OneTimeSecret({
  secret,
  label = "Secret key",
  hint = "Copy it now. It will never be shown again.",
}: {
  secret: string;
  label?: string;
  hint?: string;
}): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const id = React.useId();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
      <p className="text-sm font-medium" id={`${id}-label`}>
        {label} — copy now
      </p>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{hint}</p>
      <div className="mt-3 flex items-center gap-2">
        <code
          aria-labelledby={`${id}-label`}
          className={cn(
            "flex-1 overflow-x-auto rounded border border-zinc-200 bg-white px-3 py-2 font-mono text-sm dark:border-zinc-800 dark:bg-zinc-950",
          )}
        >
          {revealed ? secret : "•".repeat(24)}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide secret" : "Reveal secret"}
          aria-pressed={revealed}
        >
          {revealed ? (
            <EyeOff aria-hidden="true" />
          ) : (
            <Eye aria-hidden="true" />
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy secret to clipboard"}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <p
        className="mt-2 text-xs text-zinc-500 dark:text-zinc-400"
        role="status"
      >
        {copied
          ? "Copied to clipboard."
          : "Stored in memory only — it disappears if you reload."}
      </p>
    </div>
  );
}
