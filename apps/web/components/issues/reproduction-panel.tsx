"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "@replaybug/api-client";
import { api, getApiBaseUrl } from "@/lib/api";
import {
  issueReproductionsQuery,
  reproductionQuery,
  useInvalidateDomain,
} from "@/lib/queries";
import { canGenerateReproduction, type WorkspaceRole } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

type ReproductionStatus = "pending" | "ready" | "failed";

interface ReproductionSummaryItem {
  id: string;
  eventId: string;
  status: ReproductionStatus;
  hasRedactedSteps: boolean;
  generatorVersion: string;
  generatedBy: { id: string; email: string; name: string };
  createdAt: string;
  completedAt: string | null;
}

interface ReproductionDetailItem extends ReproductionSummaryItem {
  issueId: string;
  language: string;
  framework: string;
  code: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Deterministic fallback filename; mirrors the backend sanitizer. */
function shortId(value: string): string {
  const alnum = value
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toLowerCase();
  return alnum === "" ? "00000000" : alnum.padEnd(8, "0");
}

function fallbackFilename(issueId: string, eventId: string): string {
  return `replaybug-${shortId(issueId)}-${shortId(eventId)}.spec.ts`;
}

function filenameFromDisposition(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /filename="([^"]+)"/.exec(header);
  const candidate = match?.[1];
  if (candidate === undefined || candidate.length === 0) {
    return null;
  }
  return candidate;
}

function StatusBadge({ status }: { status: ReproductionStatus }) {
  if (status === "ready") {
    return <Badge>Ready</Badge>;
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="text-red-700 dark:text-red-400">
        Failed
      </Badge>
    );
  }
  return <Badge variant="secondary">Pending</Badge>;
}

/**
 * Playwright reproduction panel for one issue.
 *
 * Generation targets the currently selected occurrence only. Every
 * deliberate Generate/Regenerate click mints a fresh random
 * Idempotency-Key; an explicit Retry after a network failure reuses the
 * stored key so the backend dedupes instead of forking history.
 * Ready code renders as escaped monospace text (React escaping — never
 * interpreted or executed). Viewers (and logged-out reads) can inspect,
 * copy and download; generation controls stay hidden for them while the
 * server still enforces 403.
 */
export function ReproductionPanel({
  projectId,
  issueId,
  eventId,
  userRole,
}: {
  projectId: string;
  issueId: string;
  /** Currently selected occurrence; null when retention expired. */
  eventId: string | null | undefined;
  userRole: WorkspaceRole;
}) {
  const searchParams = useSearchParams();
  const invalidate = useInvalidateDomain();
  const canGenerate = canGenerateReproduction(userRole);
  const list = useQuery(issueReproductionsQuery(issueId, { limit: 25 }));
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [generateError, setGenerateError] = React.useState<string | null>(null);
  const [lastKey, setLastKey] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const items = (list.data?.items ?? []) as ReproductionSummaryItem[];
  const requestedId = searchParams.get("reproduction");

  // Adopt a deep-linked reproduction (?reproduction=) when it exists in
  // history, otherwise default to the newest generation.
  React.useEffect(() => {
    if (selectedId !== null || items.length === 0) {
      return;
    }
    if (requestedId !== null && items.some((item) => item.id === requestedId)) {
      setSelectedId(requestedId);
      return;
    }
    const newest = items[0];
    if (newest !== undefined) {
      setSelectedId(newest.id);
    }
  }, [selectedId, items, requestedId]);

  React.useEffect(() => {
    if (
      requestedId !== null &&
      items.some((item) => item.id === requestedId) &&
      requestedId !== selectedId
    ) {
      setSelectedId(requestedId);
    }
  }, [requestedId, items, selectedId]);

  const detail = useQuery({
    ...reproductionQuery(selectedId ?? "missing"),
    enabled: selectedId !== null,
    // Fallback when SSE is unavailable or an event is missed: keep
    // polling a pending reproduction until it reaches a terminal state.
    // Ready/failed queries stay cache-driven (SSE invalidates them).
    refetchInterval: (query) => {
      const data = query.state.data as { status?: string } | undefined;
      return data?.status === "pending" ? 2000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const selected = (detail.data ?? null) as ReproductionDetailItem | null;

  const generate = useMutation({
    mutationFn: async (idempotencyKey: string) => {
      if (eventId === null || eventId === undefined) {
        throw new Error("Select a retained occurrence first.");
      }
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/events/{eventId}/reproductions", {
        params: { path: { eventId } },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      return data;
    },
    onSuccess: (ack) => {
      setGenerateError(null);
      setNotice(null);
      setSelectedId(ack.id);
      void invalidate.invalidateIssueReproductions(issueId);
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError) {
        if (e.code === "REPRODUCTION_BASE_URL_REQUIRED") {
          setGenerateError("BASE_URL_REQUIRED");
          return;
        }
        if (e.code === "REPRODUCTION_UNSUPPORTED_FAILURE") {
          setGenerateError("UNSUPPORTED_FAILURE");
          return;
        }
        setGenerateError(toUiError(e).message);
        return;
      }
      setGenerateError(e instanceof Error ? e.message : "Generation failed.");
    },
  });

  function deliberateGenerate(): void {
    const key =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setLastKey(key);
    generate.mutate(key);
  }

  function retryWithSameKey(): void {
    if (lastKey !== null) {
      generate.mutate(lastKey);
    }
  }

  async function copyCode(): Promise<void> {
    if (selected?.code === null || selected?.code === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selected.code);
      setNotice("Copied to clipboard.");
    } catch {
      setNotice("Copy failed — select the code manually.");
    }
  }

  async function downloadCode(): Promise<void> {
    if (selected === null || selected.status !== "ready") {
      return;
    }
    setNotice(null);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/v1/reproductions/${selected.id}/download`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Download failed (${response.status}).`);
      }
      const code = await response.text();
      const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download =
          filenameFromDisposition(
            response.headers.get("content-disposition"),
          ) ?? fallbackFilename(selected.issueId, selected.eventId);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Download failed.");
    }
  }

  return (
    <section
      aria-labelledby="reproduction-heading"
      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="reproduction-heading" className="text-sm font-semibold">
          Playwright reproduction
        </h2>
        {canGenerate && eventId !== null && eventId !== undefined ? (
          <div className="flex items-center gap-2">
            {items.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={generate.isPending}
                onClick={deliberateGenerate}
              >
                {generate.isPending ? "Generating…" : "Regenerate"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={generate.isPending}
              onClick={deliberateGenerate}
            >
              {generate.isPending
                ? "Generating…"
                : items.length > 0
                  ? "Generate again"
                  : "Generate reproduction"}
            </Button>
          </div>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        {eventId === null || eventId === undefined
          ? "No retained occurrence selected — generation needs the current occurrence."
          : "Generates from the currently selected occurrence only."}
        {!canGenerate
          ? ` Your role (${userRole}) can inspect, copy and download, but cannot generate.`
          : ""}
      </p>

      {generateError !== null ? (
        <div className="mt-3">
          {generateError === "BASE_URL_REQUIRED" ? (
            <Alert variant="destructive" title="Base URL required">
              Configure the base URL for this environment before generating a
              test.{" "}
              <Link
                href={`/app/projects/${projectId}/settings/environments`}
                className="underline"
              >
                Open environment settings →
              </Link>
            </Alert>
          ) : generateError === "UNSUPPORTED_FAILURE" ? (
            <Alert variant="destructive" title="Unsupported failure type">
              This failure type cannot be reproduced deterministically. Try an
              exception, network or console-error occurrence instead.
            </Alert>
          ) : (
            <Alert variant="destructive" title="Generation failed">
              {generateError}
              {lastKey !== null ? (
                <span className="mt-2 block">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={generate.isPending}
                    onClick={retryWithSameKey}
                  >
                    Retry with the same request
                  </Button>
                </span>
              ) : null}
            </Alert>
          )}
        </div>
      ) : null}

      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          {selectedId === null ? (
            <p className="text-sm text-zinc-500">
              {list.isPending
                ? "Loading reproduction history…"
                : "No reproductions yet."}
            </p>
          ) : detail.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : detail.isError || selected === null ? (
            <Alert variant="destructive" title="Reproduction unavailable">
              It may have been deleted or you may not have access.
              <span className="mt-2 block">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void detail.refetch()}
                >
                  Retry
                </Button>
              </span>
            </Alert>
          ) : selected.status === "pending" ? (
            <p role="status" className="text-sm text-zinc-500">
              Generating Playwright reproduction…
            </p>
          ) : selected.status === "failed" ? (
            <div className="space-y-2">
              {selected.errorCode === "REPRODUCTION_BASE_URL_REQUIRED" ? (
                <Alert variant="destructive" title="Base URL required">
                  Configure the base URL for this environment before generating
                  a test.{" "}
                  <Link
                    href={`/app/projects/${projectId}/settings/environments`}
                    className="underline"
                  >
                    Open environment settings →
                  </Link>
                </Alert>
              ) : selected.errorCode === "REPRODUCTION_UNSUPPORTED_FAILURE" ? (
                <Alert variant="destructive" title="Unsupported failure type">
                  This failure type cannot be reproduced deterministically. Try
                  an exception, network or console-error occurrence instead.
                </Alert>
              ) : (
                <Alert variant="destructive" title="Generation failed">
                  {selected.errorMessage ?? "Please try again."}
                </Alert>
              )}
              <p className="font-mono text-xs text-zinc-500">
                {selected.framework} · {selected.language} ·{" "}
                {selected.generatorVersion}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {selected.hasRedactedSteps ? (
                <Alert title="Some steps redacted">
                  Sensitive values were replaced with placeholders before
                  generation — review the script before running it against
                  production data.
                </Alert>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={selected.status} />
                <span className="font-mono text-xs text-zinc-500">
                  {selected.framework} · {selected.language} ·{" "}
                  {selected.generatorVersion}
                </span>
                <span className="ml-auto flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyCode()}
                  >
                    Copy
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void downloadCode()}
                  >
                    Download
                  </Button>
                </span>
              </div>
              {notice !== null ? (
                <p role="status" className="text-xs text-zinc-500">
                  {notice}
                </p>
              ) : null}
              <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">
                {selected.code ?? ""}
              </pre>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            History{items.length > 0 ? ` (${items.length})` : ""}
          </h3>
          {list.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : list.isError ? (
            <Alert variant="destructive" title="History unavailable">
              Please try again.
              <span className="mt-2 block">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void list.refetch()}
                >
                  Retry
                </Button>
              </span>
            </Alert>
          ) : items.length === 0 ? (
            <p className="text-xs text-zinc-500">
              Each generation adds a row here.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {items.map((item) => {
                const active = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(item.id);
                        setNotice(null);
                      }}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left text-xs",
                        active
                          ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                          : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <StatusBadge status={item.status} />
                        <span className="font-mono text-zinc-500">
                          {item.generatorVersion}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-zinc-600 dark:text-zinc-400">
                        {item.generatedBy.name} ·{" "}
                        {formatDateTime(item.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
