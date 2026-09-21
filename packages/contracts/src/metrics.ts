import { z } from "zod";

/**
 * Block 6 diagnosis-focused project metrics DTOs.
 * All aggregates come from SQL (`COUNT`, date buckets); raw event sets are
 * never transferred. Buckets are UTC; no page views, no vanity analytics.
 */

export const metricsRangeSchema = z.enum(["24h", "7d", "30d"]);
export type MetricsRange = z.infer<typeof metricsRangeSchema>;

export const metricsQuerySchema = z.object({
  range: metricsRangeSchema.default("7d"),
});
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

export const metricsBucketSizeSchema = z.enum(["hourly", "daily"]);
export type MetricsBucketSize = z.infer<typeof metricsBucketSizeSchema>;

export const metricsBucketSchema = z.object({
  bucketStart: z.string().datetime(),
  occurrences: z.number().int().min(0),
  newIssues: z.number().int().min(0),
});
export type MetricsBucket = z.infer<typeof metricsBucketSchema>;

export const topIssueEntrySchema = z.object({
  issueId: z.string().uuid(),
  title: z.string().min(1),
  occurrences: z.number().int().min(0),
});
export type TopIssueEntry = z.infer<typeof topIssueEntrySchema>;

export const metricsDistributionEntrySchema = z.object({
  key: z.string().min(1),
  occurrences: z.number().int().min(0),
});
export type MetricsDistributionEntry = z.infer<
  typeof metricsDistributionEntrySchema
>;

export const projectMetricsSchema = z.object({
  range: metricsRangeSchema,
  bucketStart: z.string().datetime(),
  bucketEnd: z.string().datetime(),
  bucketSize: metricsBucketSizeSchema,
  unresolvedCount: z.number().int().min(0),
  newIssueCount: z.number().int().min(0),
  occurrenceCount: z.number().int().min(0),
  affectedSessionCount: z.number().int().min(0),
  regressionCount: z.number().int().min(0),
  topIssues: z.array(topIssueEntrySchema),
  overTime: z.array(metricsBucketSchema),
  byEnvironment: z.array(metricsDistributionEntrySchema),
  byRelease: z.array(metricsDistributionEntrySchema),
});
export type ProjectMetrics = z.infer<typeof projectMetricsSchema>;
