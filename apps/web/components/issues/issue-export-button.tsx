"use client";

import * as React from "react";
import { getApiBaseUrl } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const safeJsonFilename = /^[a-zA-Z0-9][a-zA-Z0-9._ -]*\.json$/iu;

/** The fallback is derived from the issue id only; issue content never names a download. */
export function fallbackFilename(issueId: string): string {
  const safeId = issueId.replace(/[^a-zA-Z0-9-]/gu, "").slice(0, 64);
  return `replaybug-issue-${safeId || "unknown"}.json`;
}

/** Accept only a quoted, conservative JSON filename from Content-Disposition. */
export function filenameFromDisposition(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /(?:^|;)\s*filename="([^"]*)"(?:;|$)/iu.exec(header);
  const candidate = match?.[1];
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.length > 128 ||
    !safeJsonFilename.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

export function IssueExportButton({
  issueId,
  eventId,
}: {
  issueId: string;
  eventId?: string | null;
}): React.JSX.Element {
  const [downloading, setDownloading] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function downloadExport(): Promise<void> {
    setDownloading(true);
    setStatus(null);
    setError(null);
    const query =
      eventId === null || eventId === undefined
        ? ""
        : `?eventId=${encodeURIComponent(eventId)}`;

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/v1/issues/${encodeURIComponent(issueId)}/export${query}`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        throw new Error(`Export failed (${response.status}).`);
      }
      const exportData: unknown = await response.json();
      const serialized = JSON.stringify(exportData);
      if (serialized === undefined) {
        throw new Error("Export failed: the response was empty.");
      }

      const blob = new Blob([serialized], {
        type: "application/json;charset=utf-8",
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download =
        filenameFromDisposition(response.headers.get("content-disposition")) ??
        fallbackFilename(issueId);
      try {
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }
      setStatus("Export downloaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={downloading}
        onClick={() => void downloadExport()}
      >
        {downloading ? "Exporting…" : "Export issue"}
      </Button>
      {status !== null ? (
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-zinc-500"
        >
          {status}
        </span>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Export failed">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}
