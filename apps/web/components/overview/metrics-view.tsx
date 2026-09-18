"use client";

import * as React from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate } from "@/lib/format";

export interface MetricsDatum {
  range: string;
  bucketSize: string;
  unresolvedCount: number;
  newIssueCount: number;
  occurrenceCount: number;
  affectedSessionCount: number;
  regressionCount: number;
  topIssues: Array<{ issueId: string; title: string; occurrences: number }>;
  overTime: Array<{
    bucketStart: string;
    occurrences: number;
    newIssues: number;
  }>;
  byEnvironment: Array<{ key: string; occurrences: number }>;
  byRelease: Array<{ key: string; occurrences: number }>;
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Diagnosis-focused project metrics: aggregate cards, occurrence trend,
 * environment/release distribution and top issues. All data is aggregated
 * server-side; charts render empty states instead of fake series.
 */
export function MetricsView({
  projectId,
  metrics,
}: {
  projectId: string;
  metrics: MetricsDatum;
}) {
  const trend = React.useMemo(
    () =>
      metrics.overTime.map((b) => ({
        ...b,
        label: formatDate(b.bucketStart),
      })),
    [metrics.overTime],
  );
  const hasTrend = trend.some((b) => b.occurrences > 0 || b.newIssues > 0);

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Unresolved" value={metrics.unresolvedCount} />
        <StatCard
          label={`New (${metrics.range})`}
          value={metrics.newIssueCount}
        />
        <StatCard label="Occurrences" value={metrics.occurrenceCount} />
        <StatCard label="Sessions" value={metrics.affectedSessionCount} />
        <StatCard label="Regressions" value={metrics.regressionCount} />
      </dl>

      <section
        aria-labelledby="trend-heading"
        className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <h2 id="trend-heading" className="text-sm font-semibold">
          Occurrences over time ({metrics.bucketSize})
        </h2>
        {hasTrend ? (
          <div className="mt-2 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={trend}
                margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#a1a1aa"
                  strokeOpacity={0.3}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  minTickGap={48}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="occurrences"
                  name="Occurrences"
                  stroke="#6366f1"
                  fill="#6366f1"
                  fillOpacity={0.25}
                />
                <Area
                  type="monotone"
                  dataKey="newIssues"
                  name="New issues"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.25}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="mt-2 text-sm text-zinc-500">
            No occurrences in this range. Trigger an error in the demo app or
            check back later.
          </p>
        )}
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <section
          aria-labelledby="env-heading"
          className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 id="env-heading" className="text-sm font-semibold">
            By environment
          </h2>
          {metrics.byEnvironment.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No data in range.</p>
          ) : (
            <div className="mt-2 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={metrics.byEnvironment}
                  layout="vertical"
                  margin={{ left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#a1a1aa"
                    strokeOpacity={0.3}
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="key"
                    tick={{ fontSize: 11 }}
                    width={90}
                  />
                  <Tooltip />
                  <Bar
                    dataKey="occurrences"
                    name="Occurrences"
                    fill="#6366f1"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
        <section
          aria-labelledby="release-heading"
          className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 id="release-heading" className="text-sm font-semibold">
            By release
          </h2>
          {metrics.byRelease.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No data in range.</p>
          ) : (
            <div className="mt-2 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={metrics.byRelease}
                  layout="vertical"
                  margin={{ left: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#a1a1aa"
                    strokeOpacity={0.3}
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="key"
                    tick={{ fontSize: 11 }}
                    width={90}
                  />
                  <Tooltip />
                  <Bar
                    dataKey="occurrences"
                    name="Occurrences"
                    fill="#10b981"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>
      </div>

      <section
        aria-labelledby="top-heading"
        className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <h2 id="top-heading" className="text-sm font-semibold">
          Top issues by occurrences
        </h2>
        {metrics.topIssues.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No issues in range.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
            {metrics.topIssues.map((issue) => (
              <li
                key={issue.issueId}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <Link
                  href={`/app/projects/${projectId}/issues/${issue.issueId}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                >
                  {issue.title}
                </Link>
                <span className="shrink-0 font-mono text-xs text-zinc-500">
                  {issue.occurrences} occurrence
                  {issue.occurrences === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
