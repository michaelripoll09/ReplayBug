import { describe, expect, it } from "vitest";
import { issueExportQuerySchema, issueExportSchema } from "./issue-export.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-18T12:00:00.000Z";

const issue = {
  id: UUID,
  projectId: OTHER_UUID,
  type: "exception",
  title: "TypeError: boom",
  normalizedMessage: "TypeError: boom",
  status: "investigating",
  severity: "error",
  firstSeenAt: ISO,
  lastSeenAt: ISO,
  resolvedAt: null,
  firstRelease: "web@1.0.0",
  lastRelease: "web@1.0.1",
  occurrenceCount: 3,
  affectedSessionCount: 2,
  tags: [{ id: UUID, name: "Frontend", slug: "frontend" }],
  createdAt: ISO,
  updatedAt: ISO,
};

const occurrence = {
  eventId: UUID,
  sessionId: OTHER_UUID,
  occurredAt: ISO,
  receivedAt: ISO,
  environment: "production",
  release: "web@1.0.1",
  pageUrl: "https://example.com/checkout",
  eventType: "exception",
  processingState: "processed",
};

const timelineEvent = {
  id: UUID,
  sequenceNumber: 7,
  eventType: "message",
  occurredAt: ISO,
  receivedAt: ISO,
  environment: "production",
  release: null,
  pageUrl: null,
  processingState: "processed",
  summary: "info: safe summary",
};

describe("issue export contract", () => {
  it("accepts nullable occurrence data and reproduction event references", () => {
    const parsed = issueExportSchema.parse({
      exportedAt: ISO,
      issue,
      occurrence: null,
      stack: null,
      timeline: [],
      reproductions: [
        {
          id: UUID,
          eventId: null,
          status: "failed",
          language: "typescript",
          framework: "playwright",
          hasRedactedSteps: false,
          generatorVersion: "1.0.0",
          errorCode: "REPRODUCTION_FAILED",
          completedAt: ISO,
          createdAt: ISO,
        },
      ],
    });

    expect(parsed.occurrence).toBeNull();
    expect(parsed.stack).toBeNull();
    expect(parsed.reproductions[0]?.eventId).toBeNull();
  });

  it("strips fields outside the export allowlist at every boundary", () => {
    const parsed = issueExportSchema.parse({
      exportedAt: ISO,
      issue: {
        ...issue,
        assignee: { id: "user-secret", email: "secret@example.com" },
        fingerprint: "a".repeat(64),
        fingerprintSignature: "private-signature",
      },
      occurrence: {
        ...occurrence,
        payloadJson: { secret: "telemetry-bag" },
        rejectionReason: "internal reason",
      },
      stack: {
        symbolicationStatus: null,
        rawFrames: [{ filename: "app.js", storageKey: "private-key" }],
        mappedFrames: null,
        preferredStack: [{ filename: "app.js", arbitrary: "dropped" }],
        payload: { secret: "dropped" },
      },
      timeline: [{ ...timelineEvent, payload: { comment: "dropped" } }],
      reproductions: [
        {
          id: UUID,
          eventId: null,
          status: "ready",
          language: "typescript",
          framework: "playwright",
          hasRedactedSteps: true,
          generatorVersion: "1.0.0",
          errorCode: null,
          completedAt: null,
          createdAt: ISO,
          code: "await page.goto('secret')",
          generatedBy: { id: "user-secret", email: "secret@example.com" },
          errorMessage: "private failure",
        },
      ],
      requestId: "must-not-be-exported",
    });

    expect(parsed).not.toHaveProperty("requestId");
    expect(parsed.issue).not.toHaveProperty("assignee");
    expect(parsed.issue).not.toHaveProperty("fingerprint");
    expect(parsed.issue).not.toHaveProperty("fingerprintSignature");
    expect(parsed.occurrence).not.toHaveProperty("payloadJson");
    expect(parsed.stack?.rawFrames[0]).not.toHaveProperty("storageKey");
    expect(parsed.stack).not.toHaveProperty("payload");
    expect(parsed.timeline[0]).not.toHaveProperty("payload");
    expect(parsed.reproductions[0]).not.toHaveProperty("code");
    expect(parsed.reproductions[0]).not.toHaveProperty("generatedBy");
    expect(parsed.reproductions[0]).not.toHaveProperty("errorMessage");
  });

  it("rejects the UI-only event query and malformed event ids", () => {
    expect(issueExportQuerySchema.parse({ eventId: UUID })).toEqual({
      eventId: UUID,
    });
    expect(() => issueExportQuerySchema.parse({ event: UUID })).toThrow();
    expect(() =>
      issueExportQuerySchema.parse({ eventId: "not-a-uuid" }),
    ).toThrow();
  });
});
