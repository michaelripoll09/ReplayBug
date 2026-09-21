"use client";

import * as React from "react";
import {
  getPublicDemoIssue,
  getPublicDemoOverview,
  getPublicDemoSession,
  listPublicDemoAi,
  listPublicDemoIssues,
  listPublicDemoOccurrences,
  listPublicDemoReproductions,
  PublicDemoRequestError,
  type PublicDemoAiAnalysis,
  type PublicDemoIssue,
  type PublicDemoOccurrence,
  type PublicDemoOverview,
  type PublicDemoReproduction,
  type PublicDemoSession,
} from "@/lib/public-demo";

const demoAppUrl =
  process.env["NEXT_PUBLIC_REPLAYBUG_DEMO_URL"] ?? "http://localhost:5173";

type SummaryState =
  | { kind: "loading" }
  | { kind: "ready"; overview: PublicDemoOverview; issues: PublicDemoIssue[] }
  | { kind: "unavailable" }
  | { kind: "error" };

type DetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready";
      issue: PublicDemoIssue;
      occurrences: PublicDemoOccurrence[];
      reproductions: PublicDemoReproduction[];
      analyses: PublicDemoAiAnalysis[];
      session: PublicDemoSession | null;
    }
  | { kind: "unavailable" }
  | { kind: "error" };

function isUnavailable(error: unknown): boolean {
  return error instanceof PublicDemoRequestError && error.status === 404;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function OverviewCount({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <dt className="text-sm text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function EmptyDetail(): React.JSX.Element {
  return (
    <section
      aria-labelledby="selected-issue-heading"
      className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
    >
      <h2 id="selected-issue-heading" className="text-lg font-semibold">
        Selected issue
      </h2>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Synthetic demo data has no issues yet.
      </p>
    </section>
  );
}

export default function PublicDemoPage(): React.JSX.Element {
  const [summary, setSummary] = React.useState<SummaryState>({
    kind: "loading",
  });
  const [selectedIssueId, setSelectedIssueId] = React.useState<string | null>(
    null,
  );
  const [detail, setDetail] = React.useState<DetailState>({ kind: "idle" });
  const [selectedSessionId, setSelectedSessionId] = React.useState<
    string | null
  >(null);

  React.useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getPublicDemoOverview(controller.signal),
      listPublicDemoIssues(controller.signal),
    ])
      .then(([overview, issues]) => {
        if (controller.signal.aborted) {
          return;
        }
        setSummary({ kind: "ready", overview, issues });
        setSelectedIssueId(issues[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setSummary({ kind: isUnavailable(error) ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, []);

  React.useEffect(() => {
    if (selectedIssueId === null) {
      setDetail({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setDetail({ kind: "loading" });
    setSelectedSessionId(null);
    void Promise.all([
      getPublicDemoIssue(selectedIssueId, controller.signal),
      listPublicDemoOccurrences(selectedIssueId, controller.signal),
      listPublicDemoReproductions(selectedIssueId, controller.signal),
      listPublicDemoAi(selectedIssueId, controller.signal),
    ])
      .then(async ([issue, occurrences, reproductions, analyses]) => {
        const firstSessionId = occurrences[0]?.sessionId ?? null;
        const session =
          firstSessionId === null
            ? null
            : await getPublicDemoSession(firstSessionId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setSelectedSessionId(firstSessionId);
        setDetail({
          kind: "ready",
          issue,
          occurrences,
          reproductions,
          analyses,
          session,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setDetail({ kind: isUnavailable(error) ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, [selectedIssueId]);

  const selectSession = (sessionId: string): void => {
    if (detail.kind !== "ready" || sessionId === selectedSessionId) {
      return;
    }
    setSelectedSessionId(sessionId);
    void getPublicDemoSession(sessionId)
      .then((session) => {
        setDetail((current) =>
          current.kind === "ready" ? { ...current, session } : current,
        );
      })
      .catch(() => {
        setDetail((current) =>
          current.kind === "ready" ? { ...current, session: null } : current,
        );
      });
  };

  if (summary.kind === "loading") {
    return (
      <main className="mx-auto max-w-6xl p-6" role="status">
        Loading public demo…
      </main>
    );
  }

  if (summary.kind === "unavailable") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <section
          role="alert"
          aria-labelledby="demo-unavailable-heading"
          className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800"
        >
          <h1 id="demo-unavailable-heading" className="text-2xl font-semibold">
            ReplayBug Demo
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-300">
            The public demo is disabled or unavailable right now.
          </p>
        </section>
      </main>
    );
  }

  if (summary.kind === "error") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <section
          role="alert"
          aria-labelledby="demo-error-heading"
          className="rounded-lg border border-red-300 p-6 dark:border-red-900"
        >
          <h1 id="demo-error-heading" className="text-2xl font-semibold">
            ReplayBug Demo
          </h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-300">
            We could not load the read-only demo. Please try again later.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Synthetic data · Read-only
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            ReplayBug Demo
          </h1>
          <p className="mt-2 max-w-2xl text-zinc-600 dark:text-zinc-300">
            A safe, public portfolio view of how ReplayBug connects issues,
            sessions, reproductions, and AI-assisted investigation.
          </p>
        </div>
        <a
          href={demoAppUrl}
          className="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-950"
        >
          Open buggy demo app
        </a>
      </header>

      <section aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="text-lg font-semibold">
          Overview
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <OverviewCount label="Issues" value={summary.overview.issueCount} />
          <OverviewCount
            label="Sessions"
            value={summary.overview.sessionCount}
          />
          <OverviewCount
            label="Releases"
            value={summary.overview.releaseCount}
          />
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section
          aria-labelledby="issues-heading"
          className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
        >
          <h2 id="issues-heading" className="text-lg font-semibold">
            Issues
          </h2>
          <ul className="mt-3 space-y-2">
            {summary.issues.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  onClick={() => setSelectedIssueId(issue.id)}
                  aria-current={
                    issue.id === selectedIssueId ? "true" : undefined
                  }
                  className="w-full rounded-md border border-zinc-200 p-3 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <span className="block font-medium">{issue.title}</span>
                  <span className="mt-1 block text-sm text-zinc-500 dark:text-zinc-400">
                    {issue.status} · {issue.severity} · {issue.occurrenceCount}{" "}
                    occurrences
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {detail.kind === "idle" ? <EmptyDetail /> : null}
        {detail.kind === "loading" ? (
          <section
            role="status"
            className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
          >
            Loading selected issue…
          </section>
        ) : null}
        {detail.kind === "unavailable" ? (
          <section
            role="alert"
            className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
          >
            This public issue is no longer available.
          </section>
        ) : null}
        {detail.kind === "error" ? (
          <section
            role="alert"
            className="rounded-lg border border-red-300 p-5 dark:border-red-900"
          >
            Selected issue details could not be loaded.
          </section>
        ) : null}
        {detail.kind === "ready" ? (
          <section
            aria-labelledby="selected-issue-heading"
            className="space-y-6 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
          >
            <div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Selected issue
              </p>
              <h2
                id="selected-issue-heading"
                className="mt-1 text-xl font-semibold"
              >
                {detail.issue.title}
              </h2>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                {detail.issue.normalizedMessage}
              </p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">Status / severity</dt>
                  <dd className="font-medium">
                    {detail.issue.status} · {detail.issue.severity}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">
                    Occurrences / affected sessions
                  </dt>
                  <dd className="font-medium">
                    {detail.issue.occurrenceCount} ·{" "}
                    {detail.issue.affectedSessionCount}
                  </dd>
                </div>
              </dl>
            </div>

            <section aria-labelledby="source-mapped-stack-heading">
              <h3 id="source-mapped-stack-heading" className="font-semibold">
                Source-mapped stack
              </h3>
              {detail.issue.evidence === undefined ? (
                <p className="mt-2 text-sm text-zinc-500">
                  No stack evidence is available.
                </p>
              ) : detail.issue.evidence.mappedFrames.length > 0 ? (
                <ol className="mt-2 space-y-2 text-sm">
                  {detail.issue.evidence.mappedFrames.map((frame, index) => (
                    <li
                      key={`mapped-frame-${index}`}
                      className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
                    >
                      <span>Filename: {frame.filename ?? "Unknown file"}</span>
                      <span>
                        {" · "}Function: {frame.function ?? "Unknown function"}
                      </span>
                      <span>
                        {" · "}Source: {frame.source ?? "Unavailable"}
                      </span>
                      <span>
                        {" · "}Line: {frame.line ?? "Unknown"}
                      </span>
                      <span>
                        {" · "}Column: {frame.column ?? "Unknown"}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : detail.issue.evidence.rawFrames.length > 0 ? (
                <ol className="mt-2 space-y-2 text-sm">
                  {detail.issue.evidence.rawFrames.map((frame, index) => (
                    <li
                      key={`raw-frame-${index}`}
                      className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
                    >
                      <span className="font-medium">Raw fallback</span>
                      <span>
                        {" · "}Filename: {frame.filename ?? "Unknown file"}
                      </span>
                      <span>
                        {" · "}Function: {frame.function ?? "Unknown function"}
                      </span>
                      <span>{" · "}Source: unavailable</span>
                      <span>
                        {" · "}Line: {frame.lineno ?? "Unknown"}
                      </span>
                      <span>
                        {" · "}Column: {frame.colno ?? "Unknown"}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">
                  No stack frames are available.
                </p>
              )}
            </section>

            <section aria-labelledby="occurrences-heading">
              <h3 id="occurrences-heading" className="font-semibold">
                Occurrences
              </h3>
              <ul className="mt-2 space-y-2 text-sm">
                {detail.occurrences.map((occurrence) => (
                  <li
                    key={occurrence.id}
                    className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
                  >
                    <span>
                      {occurrence.eventType} · {occurrence.environment} ·{" "}
                      {displayDate(occurrence.occurredAt)}
                    </span>
                    <a
                      href="#session-timeline"
                      onClick={() => selectSession(occurrence.sessionId)}
                      className="ml-2 underline"
                    >
                      View session timeline
                    </a>
                  </li>
                ))}
                {detail.occurrences.length === 0 ? (
                  <li className="text-zinc-500">
                    No public occurrences are available.
                  </li>
                ) : null}
              </ul>
            </section>

            <section aria-labelledby="reproduction-heading">
              <h3 id="reproduction-heading" className="font-semibold">
                Reproduction summary
              </h3>
              {detail.reproductions[0] === undefined ? (
                <p className="mt-2 text-sm text-zinc-500">
                  No synthetic reproduction is available.
                </p>
              ) : (
                <p className="mt-2 text-sm">
                  {detail.reproductions[0].status} ·{" "}
                  {detail.reproductions[0].framework} ·{" "}
                  {detail.reproductions[0].language}
                  {detail.reproductions[0].hasRedactedSteps
                    ? " · Redacted steps"
                    : ""}
                </p>
              )}
            </section>

            <section aria-labelledby="ai-example-heading">
              <h3 id="ai-example-heading" className="font-semibold">
                Synthetic AI example
              </h3>
              {detail.analyses[0] === undefined ? (
                <p className="mt-2 text-sm text-zinc-500">
                  No synthetic AI analysis is available.
                </p>
              ) : (
                <div className="mt-2 space-y-2 text-sm">
                  <p>
                    {detail.analyses[0].summary ??
                      "Analysis summary unavailable."}
                  </p>
                  {detail.analyses[0].suspectedCause !== null ? (
                    <p>
                      <span className="font-medium">Hypothesis:</span>{" "}
                      {detail.analyses[0].suspectedCause}
                    </p>
                  ) : null}
                  {detail.analyses[0].reproductionSteps.length > 0 ? (
                    <ol className="list-decimal pl-5">
                      {detail.analyses[0].reproductionSteps.map(
                        (step, index) => (
                          <li
                            key={`${detail.analyses[0]?.id ?? "analysis"}-${index}`}
                          >
                            {step}
                          </li>
                        ),
                      )}
                    </ol>
                  ) : null}
                </div>
              )}
            </section>

            <section id="session-timeline" aria-labelledby="timeline-heading">
              <h3 id="timeline-heading" className="font-semibold">
                Session timeline
              </h3>
              {detail.session === null ? (
                <p className="mt-2 text-sm text-zinc-500">
                  Session timeline unavailable.
                </p>
              ) : (
                <div className="mt-2 text-sm">
                  <p className="text-zinc-500">
                    {detail.session.browserName ?? "Unknown browser"} ·{" "}
                    {detail.session.osName ?? "Unknown OS"} ·{" "}
                    {detail.session.initialUrl}
                  </p>
                  <ol className="mt-2 space-y-1 border-l border-zinc-200 pl-4 dark:border-zinc-800">
                    {detail.session.timeline.map((event) => (
                      <li key={event.id}>
                        {displayDate(event.occurredAt)} · {event.eventType}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>

            <p className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
              Sensitive input changed — value not captured.
            </p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
