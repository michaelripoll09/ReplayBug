"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError } from "@replaybug/api-client";
import { api } from "@/lib/api";
import {
  aiAnalysisClient,
  aiAnalysisQuery,
  aiCapabilityQuery,
  issueAiAnalysesQuery,
  useInvalidateDomain,
} from "@/lib/queries";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/**
 * The mandatory, always-visible hypothesis disclaimer. Rendered as plain
 * visible text (never a tooltip, never a title attribute) so a reader can
 * never mistake an AI hypothesis for a verified cause.
 */
export const AI_HYPOTHESIS_DISCLAIMER =
  "AI-generated hypothesis based on captured telemetry. It may be wrong.";

type AiStatus = "pending" | "ready" | "failed";

interface AiHistoryItem {
  id: string;
  eventId: string | null;
  model: string;
  status: AiStatus;
  analysisVersion: string;
  requestedBy: { id: string; email: string; name: string } | null;
  createdAt: string;
  completedAt: string | null;
}

interface AiEvidenceItem {
  ref: string;
  reason: string;
}

interface AiDetailItem extends AiHistoryItem {
  issueId: string;
  summary: string | null;
  suspectedCause: string | null;
  evidence: AiEvidenceItem[] | null;
  reproductionSteps: string[] | null;
  limitations: string[] | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function StatusBadge({ status }: { status: AiStatus }): React.JSX.Element {
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
 * Safe failure copy keyed by the server error code only. Raw
 * `errorMessage`, provider bodies, traces and URLs are never rendered.
 */
function failureCopy(errorCode: string | null): {
  title: string;
  message: string;
  retryable: boolean;
} {
  switch (errorCode) {
    case "AI_ANALYSIS_DISABLED":
    case "AI_ANALYSIS_MISCONFIGURED":
      return {
        title: "Local AI analysis is not configured",
        message: "Core ReplayBug functionality does not require AI.",
        retryable: false,
      };
    case "AI_ANALYSIS_INVALID_EVIDENCE":
      return {
        title: "Evidence unavailable",
        message: "The referenced evidence is no longer available.",
        retryable: false,
      };
    case "AI_ANALYSIS_TIMEOUT":
      return {
        title: "The local model timed out",
        message: "Ollama did not respond in time. You can try again.",
        retryable: true,
      };
    case "AI_ANALYSIS_PROVIDER_UNAVAILABLE":
      return {
        title: "Ollama unavailable",
        message: "The local model was unavailable. You can try again.",
        retryable: true,
      };
    case "AI_ANALYSIS_PROVIDER_REJECTED":
      return {
        title: "The local model rejected the request",
        message: "You can try again.",
        retryable: true,
      };
    case "AI_ANALYSIS_RESPONSE_INVALID":
      return {
        title: "Invalid model response",
        message:
          "The local model returned an invalid structured response. You can try again.",
        retryable: true,
      };
    default:
      return {
        title: "AI analysis failed",
        message: "Please try again.",
        retryable: true,
      };
  }
}

/** Applies a transient highlight so a ref click is scannable by more than color. */
function highlightElement(element: Element): void {
  element.setAttribute("data-ai-highlight", "true");
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  window.setTimeout(() => {
    element.removeAttribute("data-ai-highlight");
  }, 2000);
}

/**
 * One evidence ref row. The ref is opaque and model-authored, so it is
 * classified against the known deterministic ref schemes only; anything
 * else degrades to a plain-text "Evidence no longer retained" note with no
 * link and no crash.
 */
function EvidenceRow({
  item,
  retained,
  onReveal,
  projectId,
  issueId,
}: {
  item: AiEvidenceItem;
  retained: boolean;
  onReveal: (ref: string) => void;
  projectId: string;
  issueId: string;
}): React.JSX.Element {
  const stackMatch = /^stack:(\d+)$/.exec(item.ref);
  const eventMatch = /^(?:timeline|network):(.+)$/.exec(item.ref);
  const eventId = eventMatch?.[1];
  const isEventRef = eventId !== undefined && UUID_RE.test(eventId);
  const isStaticRef =
    item.ref === "issue:message" || item.ref === "release:current";
  const navigable = stackMatch !== null || isEventRef;

  return (
    <li className="rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <span className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono dark:bg-zinc-800">
          {item.ref}
        </code>
        {!retained && !isStaticRef ? (
          <span className="text-zinc-500">Evidence no longer retained</span>
        ) : stackMatch !== null ? (
          <button
            type="button"
            onClick={() => onReveal(item.ref)}
            className="underline"
          >
            Highlight frame {stackMatch[1]}
          </button>
        ) : isEventRef && eventId !== undefined ? (
          <Link
            href={`/app/projects/${projectId}/issues/${issueId}?event=${eventId}`}
            onClick={() => onReveal(item.ref)}
            className="underline"
          >
            {item.ref.startsWith("network:")
              ? "View network event"
              : "View timeline event"}
          </Link>
        ) : navigable ? (
          <span className="text-zinc-500">Evidence no longer retained</span>
        ) : null}
      </span>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">{item.reason}</p>
    </li>
  );
}

/**
 * Optional local AI analysis panel for one issue.
 *
 * The request always targets the currently selected occurrence, never
 * silently the newest. Every deliberate Analyze/Analyze again click mints a
 * fresh random Idempotency-Key; an explicit Retry after a transport failure
 * reuses the stored key so the backend dedupes instead of forking history.
 * All model text renders as inert React text/lists — no
 * dangerouslySetInnerHTML, no links from model-authored strings. Viewers can
 * read history and detail but get no request/retry controls while the server
 * still enforces 403. Convergence relies on SSE invalidation and normal
 * refetch-on-focus; there is no polling loop.
 */
export function AiAnalysisPanel({
  projectId,
  issueId,
  selectedEventId,
  canRequest,
  isEvidenceRetained,
}: {
  projectId: string;
  issueId: string;
  /** Currently selected occurrence; null/undefined when none is retained. */
  selectedEventId: string | null | undefined;
  /** Role-derived affordance; the API remains the authority (viewer 403). */
  canRequest: boolean;
  /**
   * Retention predicate supplied by the page. When omitted, recognized refs
   * are treated as retained so the panel still renders navigable controls.
   */
  isEvidenceRetained?: (ref: string) => boolean;
}): React.JSX.Element {
  const invalidate = useInvalidateDomain();
  const capability = useQuery(aiCapabilityQuery());
  const list = useQuery(issueAiAnalysesQuery(issueId, { limit: 25 }));
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [lastKey, setLastKey] = React.useState<string | null>(null);

  const capabilityData = capability.data?.aiAnalysis;
  const configured = capabilityData?.configured === true;
  const items = (list.data?.items ?? []) as AiHistoryItem[];

  React.useEffect(() => {
    if (selectedId !== null || items.length === 0) {
      return;
    }
    setSelectedId(items[0]?.id ?? null);
  }, [selectedId, items]);

  const detail = useQuery({
    ...aiAnalysisQuery(selectedId ?? "missing"),
    enabled: selectedId !== null,
  });
  const selected = (detail.data ?? null) as AiDetailItem | null;

  const request = useMutation({
    mutationFn: async (idempotencyKey: string) => {
      if (selectedEventId === null || selectedEventId === undefined) {
        throw new Error("Select a retained occurrence first.");
      }
      const {
        data,
        error: apiError,
        response,
      } = await aiAnalysisClient.POST("/api/v1/events/{eventId}/ai-analyses", {
        params: { path: { eventId: selectedEventId } },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      return data;
    },
    onSuccess: (ack) => {
      setRequestError(null);
      setSelectedId(ack.id);
      void invalidate.invalidateIssueAiAnalyses(issueId);
      void invalidate.invalidateIssueActivity(issueId);
    },
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.code === "AI_NOT_CONFIGURED") {
        setRequestError("AI_NOT_CONFIGURED");
        return;
      }
      setRequestError(toUiError(e).message);
    },
  });

  function deliberateAnalyze(): void {
    const key =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setLastKey(key);
    request.mutate(key);
  }

  function retryWithSameKey(): void {
    if (lastKey !== null) {
      request.mutate(lastKey);
    }
  }

  function revealEvidence(ref: string): void {
    const stackMatch = /^stack:(\d+)$/.exec(ref);
    if (stackMatch !== null) {
      const frame = document.querySelector(
        `[data-stack-frame-index="${stackMatch[1]}"]`,
      );
      const target = frame ?? document.getElementById("occurrence-evidence");
      if (target !== null) {
        highlightElement(target);
      }
      return;
    }
    const eventMatch = /^(?:timeline|network):(.+)$/.exec(ref);
    if (eventMatch !== null) {
      const anchor = document.querySelector(
        `[data-timeline-event-id="${eventMatch[1]}"]`,
      );
      const target = anchor ?? document.getElementById("session-context");
      if (target !== null) {
        highlightElement(target);
      }
    }
  }

  const retained = isEvidenceRetained ?? (() => true);
  const hasRetainedOccurrence =
    selectedEventId !== null && selectedEventId !== undefined;
  // A retry control is only honest when the AI capability is actually
  // configured; otherwise it can only end in 503 AI_NOT_CONFIGURED.
  const canRetryFailed = configured && canRequest && hasRetainedOccurrence;
  const limitations = selected?.limitations ?? [];
  const evidence = selected?.evidence ?? [];
  const steps = selected?.reproductionSteps ?? [];

  return (
    <section
      id="ai-analysis"
      aria-labelledby="ai-analysis-heading"
      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-analysis-heading" className="text-sm font-semibold">
          AI analysis
        </h2>
        {configured ? (
          <span className="font-mono text-xs text-zinc-500">
            {capabilityData?.model ?? "local model"}
          </span>
        ) : null}
      </div>

      {capability.isPending ? (
        <p role="status" className="mt-1 text-xs text-zinc-500">
          Checking local AI configuration…
        </p>
      ) : !configured ? (
        <div className="mt-1 space-y-1 text-xs text-zinc-500">
          <p>Local AI analysis is not configured.</p>
          <p>Core ReplayBug functionality does not require AI.</p>
        </div>
      ) : (
        <p className="mt-1 text-xs text-zinc-500">
          {hasRetainedOccurrence
            ? "Analyzes the currently selected occurrence only."
            : "Select a retained occurrence to analyze."}
          {!canRequest
            ? " Your role can read analysis history but cannot request new analyses."
            : ""}
        </p>
      )}

      {configured && canRequest && hasRetainedOccurrence ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={request.isPending}
            onClick={deliberateAnalyze}
          >
            {request.isPending
              ? "Analyzing with local Ollama…"
              : items.length > 0
                ? "Analyze again"
                : "Analyze with local AI"}
          </Button>
        </div>
      ) : null}

      {request.isPending ? (
        <p role="status" className="mt-2 text-xs text-zinc-500">
          Analyzing with local Ollama…
        </p>
      ) : null}

      {requestError !== null ? (
        <div className="mt-3">
          <Alert
            variant="destructive"
            title={
              requestError === "AI_NOT_CONFIGURED"
                ? "Local AI analysis is not configured"
                : "AI analysis request failed"
            }
          >
            {requestError === "AI_NOT_CONFIGURED" ? (
              <>
                Configure Ollama to use this optional feature. Core ReplayBug
                functionality does not require AI.
              </>
            ) : (
              <>
                {requestError}
                {lastKey !== null ? (
                  <span className="mt-2 block">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={request.isPending}
                      onClick={retryWithSameKey}
                    >
                      Retry with the same request
                    </Button>
                  </span>
                ) : null}
              </>
            )}
          </Alert>
        </div>
      ) : null}

      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          {selectedId === null ? (
            <p className="text-sm text-zinc-500">
              {list.isPending
                ? "Loading analysis history…"
                : "No AI analyses yet."}
            </p>
          ) : detail.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : detail.isError || selected === null ? (
            <Alert variant="destructive" title="Analysis unavailable">
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
              Analyzing with local Ollama…
            </p>
          ) : selected.status === "failed" ? (
            (() => {
              const copy = failureCopy(selected.errorCode);
              return (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status="failed" />
                    <span className="font-mono text-xs text-zinc-500">
                      {selected.model} · v{selected.analysisVersion}
                    </span>
                  </div>
                  <Alert variant="destructive" title={copy.title}>
                    {copy.message}
                  </Alert>
                  {copy.retryable && canRetryFailed ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={request.isPending}
                      onClick={deliberateAnalyze}
                    >
                      Analyze again
                    </Button>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status="ready" />
                <span className="font-mono text-xs text-zinc-500">
                  {selected.model} · v{selected.analysisVersion}
                </span>
              </div>
              <Alert variant="muted">{AI_HYPOTHESIS_DISCLAIMER}</Alert>
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Summary
                </h3>
                <p className="mt-1 text-sm">{selected.summary ?? ""}</p>
              </section>
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Suspected cause
                </h3>
                <p className="mt-1 text-sm">{selected.suspectedCause ?? ""}</p>
              </section>
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Evidence
                </h3>
                {evidence.length === 0 ? (
                  <p className="mt-1 text-xs text-zinc-500">
                    No evidence references recorded.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1.5">
                    {evidence.map((item, index) => (
                      <EvidenceRow
                        key={`${index}-${item.ref}`}
                        item={item}
                        retained={retained(item.ref)}
                        onReveal={revealEvidence}
                        projectId={projectId}
                        issueId={issueId}
                      />
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Suggested steps
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Suggestions only — never executed, and separate from the
                  deterministic Playwright reproduction below.
                </p>
                {steps.length === 0 ? (
                  <p className="mt-1 text-sm text-zinc-500">
                    No steps suggested.
                  </p>
                ) : (
                  <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">
                    {steps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                )}
              </section>
              {limitations.length > 0 ? (
                <section>
                  <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Limitations
                  </h3>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
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
              Each analysis adds a row here.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {items.map((item) => {
                const active = item.id === selectedId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
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
                          v{item.analysisVersion}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-zinc-600 dark:text-zinc-400">
                        {item.requestedBy?.name ?? "System"} ·{" "}
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
