import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import { events, issueActivity, issues } from "../schema.js";
import type { DbOrTx } from "./db-types.js";

export type MetricsBucketSize = "hour" | "day";

export interface MetricsWindow {
  projectId: string;
  start: Date;
  end: Date;
  bucket: MetricsBucketSize;
  /** Exact bucket count (24 hourly, 7/30 daily). */
  bucketCount: number;
}

export interface MetricsBucket {
  bucketStart: Date;
  occurrences: number;
  newIssues: number;
}

export interface MetricsResult {
  unresolvedCount: number;
  newIssueCount: number;
  occurrenceCount: number;
  affectedSessionCount: number;
  regressionCount: number;
  topIssues: Array<{ issueId: string; title: string; occurrences: number }>;
  overTime: MetricsBucket[];
  byEnvironment: Array<{ key: string; occurrences: number }>;
  byRelease: Array<{ key: string; occurrences: number }>;
}

export function floorBucket(date: Date, bucket: MetricsBucketSize): Date {
  const copy = new Date(date.getTime());
  if (bucket === "hour") {
    copy.setUTCMinutes(0, 0, 0);
  } else {
    copy.setUTCHours(0, 0, 0, 0);
  }
  return copy;
}

export function bucketMillis(bucket: MetricsBucketSize): number {
  return bucket === "hour" ? 3_600_000 : 86_400_000;
}

/**
 * Normalizes a `date_trunc` bucket value. node-pg returns timestamptz as
 * Date but plain `timestamp` as string, so both shapes are accepted and
 * reduced to epoch millis for bucket matching.
 */
export function bucketTime(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = Date.parse(normalized);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Unexpected metrics bucket value: ${String(value)}`);
}

function truncExpr(
  bucket: MetricsBucketSize,
  column: typeof events.occurredAt,
) {
  return bucket === "hour"
    ? sql<Date>`date_trunc('hour', ${column})`
    : sql<Date>`date_trunc('day', ${column})`;
}

function truncIssueExpr(
  bucket: MetricsBucketSize,
  column: typeof issues.createdAt,
) {
  return bucket === "hour"
    ? sql<Date>`date_trunc('hour', ${column})`
    : sql<Date>`date_trunc('day', ${column})`;
}

/**
 * Diagnosis-focused project aggregates. Every number comes from SQL
 * aggregation (`COUNT`, `date_trunc` buckets, `GROUP BY`); raw event sets
 * are never loaded. Buckets are UTC-aligned; the caller chooses hourly vs
 * daily. No page views, no vanity analytics.
 */
export async function getProjectMetrics(
  db: DbOrTx,
  input: MetricsWindow,
): Promise<MetricsResult> {
  const { projectId, start, end, bucket, bucketCount } = input;
  const inWindow = [
    eq(events.projectId, projectId),
    gte(events.occurredAt, start),
    lt(events.occurredAt, end),
  ];
  const linkedInWindow = [...inWindow, sql`${events.issueId} IS NOT NULL`];

  const unresolvedRows = await db
    .select({ value: count() })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(issues.status, ["open", "investigating"]),
      ),
    );
  const newRows = await db
    .select({ value: count() })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        gte(issues.createdAt, start),
        lt(issues.createdAt, end),
      ),
    );
  const occurrenceRows = await db
    .select({ value: count() })
    .from(events)
    .where(and(...linkedInWindow));
  const sessionRows = await db
    .select({ value: countDistinct(events.telemetrySessionId) })
    .from(events)
    .where(and(...linkedInWindow));
  const regressionRows = await db
    .select({ value: count() })
    .from(issueActivity)
    .innerJoin(issues, eq(issueActivity.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issueActivity.type, "regression_detected"),
        gte(issueActivity.createdAt, start),
        lt(issueActivity.createdAt, end),
      ),
    );

  const topRows = await db
    .select({
      issueId: issues.id,
      title: issues.title,
      occurrences: count(),
    })
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .where(and(...linkedInWindow))
    .groupBy(issues.id, issues.title)
    .orderBy(desc(count()), asc(issues.id))
    .limit(5);

  const truncEvent = truncExpr(bucket, events.occurredAt);
  const occByBucket = await db
    .select({ bucketStart: truncEvent, occurrences: count() })
    .from(events)
    .where(and(...linkedInWindow))
    .groupBy(truncEvent);

  const truncIssue = truncIssueExpr(bucket, issues.createdAt);
  const newByBucket = await db
    .select({ bucketStart: truncIssue, newIssues: count() })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        gte(issues.createdAt, start),
        lt(issues.createdAt, end),
      ),
    )
    .groupBy(truncIssue);

  const envRows = await db
    .select({ key: events.environment, occurrences: count() })
    .from(events)
    .where(and(...linkedInWindow))
    .groupBy(events.environment)
    .orderBy(desc(count()));

  const releaseRows = await db
    .select({ key: events.release, occurrences: count() })
    .from(events)
    .where(and(...linkedInWindow))
    .groupBy(events.release)
    .orderBy(desc(count()));

  const first = floorBucket(start, bucket);
  const step = bucketMillis(bucket);
  const overTime: MetricsBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    overTime.push({
      bucketStart: new Date(first.getTime() + i * step),
      occurrences: 0,
      newIssues: 0,
    });
  }
  const byTime = new Map<number, MetricsBucket>();
  for (const b of overTime) {
    byTime.set(b.bucketStart.getTime(), b);
  }
  // The window [start, end) rarely aligns with bucket edges, so the
  // trailing partial bucket folds into the last fixed bucket. Exact matches
  // win; anything past the last edge lands in the final bucket, anything
  // before the first edge (defensive only) in the first. Bucket sums always
  // reconcile with the scalar totals above.
  const firstBucket = overTime[0];
  const lastBucket = overTime[overTime.length - 1];
  const slotFor = (time: number): MetricsBucket | undefined => {
    const exact = byTime.get(time);
    if (exact !== undefined || firstBucket === undefined) {
      return exact;
    }
    return time < firstBucket.bucketStart.getTime() ? firstBucket : lastBucket;
  };
  for (const row of occByBucket) {
    const slot = slotFor(bucketTime(row.bucketStart));
    if (slot !== undefined) {
      slot.occurrences = row.occurrences;
    }
  }
  for (const row of newByBucket) {
    const slot = slotFor(bucketTime(row.bucketStart));
    if (slot !== undefined) {
      slot.newIssues = row.newIssues;
    }
  }

  return {
    unresolvedCount: unresolvedRows[0]?.value ?? 0,
    newIssueCount: newRows[0]?.value ?? 0,
    occurrenceCount: occurrenceRows[0]?.value ?? 0,
    affectedSessionCount: sessionRows[0]?.value ?? 0,
    regressionCount: regressionRows[0]?.value ?? 0,
    topIssues: topRows.map((r) => ({
      issueId: r.issueId,
      title: r.title,
      occurrences: r.occurrences,
    })),
    overTime,
    byEnvironment: envRows.map((r) => ({
      key: r.key,
      occurrences: r.occurrences,
    })),
    byRelease: releaseRows.map((r) => ({
      key: r.key ?? "unknown",
      occurrences: r.occurrences,
    })),
  };
}
