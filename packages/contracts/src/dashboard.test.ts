import { describe, expect, it } from "vitest";
import {
  createCommentRequestSchema,
  createTagRequestSchema,
  issueActivitySchema,
  issueCommentSchema,
  issueListQuerySchema,
  issueSummarySchema,
  updateIssueAssigneeRequestSchema,
  updateIssueStatusRequestSchema,
} from "./issues.js";
import {
  notificationListQuerySchema,
  notificationSchema,
} from "./notifications.js";
import { metricsQuerySchema, projectMetricsSchema } from "./metrics.js";
import {
  sessionEventSchema,
  sessionListQuerySchema,
  telemetrySessionSchema,
} from "./sessions.js";
import {
  eventDetailSchema,
  occurrenceListQuerySchema,
  occurrenceSchema,
} from "./events.js";
import { workspaceMemberSchema } from "./workspace.js";
import { activityListQuerySchema } from "./issues.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-09-18T12:00:00.000Z";

const USER = {
  id: "user-1",
  email: "dev@example.com",
  name: "Dev",
  emailVerified: true,
};

/**
 * Block 6 dashboard DTOs: strict shapes that never expose Drizzle rows,
 * fingerprint material, key hashes, raw host IDs or unsafe HTML.
 */
describe("issue contracts", () => {
  it("accepts a full issue summary with tags and nullable assignee", () => {
    const parsed = issueSummarySchema.parse({
      id: UUID,
      projectId: UUID,
      type: "exception",
      title: "TypeError: boom",
      normalizedMessage: "TypeError: boom",
      status: "open",
      severity: "error",
      assignee: null,
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
    });
    expect(parsed.tags).toHaveLength(1);
  });

  it("strips fingerprint material instead of exposing it", () => {
    const parsed = issueSummarySchema.parse({
      id: UUID,
      projectId: UUID,
      type: "exception",
      title: "Boom",
      normalizedMessage: "Boom",
      status: "open",
      severity: "error",
      assignee: USER,
      firstSeenAt: ISO,
      lastSeenAt: ISO,
      resolvedAt: null,
      firstRelease: null,
      lastRelease: null,
      occurrenceCount: 1,
      affectedSessionCount: 1,
      tags: [],
      createdAt: ISO,
      updatedAt: ISO,
      fingerprint: "a".repeat(64),
      fingerprintSignature: "secret-signature",
    });
    expect(parsed).not.toHaveProperty("fingerprint");
    expect(parsed).not.toHaveProperty("fingerprintSignature");
  });

  it("rejects unknown statuses and negative counters", () => {
    expect(() =>
      updateIssueStatusRequestSchema.parse({ status: "closed" }),
    ).toThrow();
    expect(() =>
      issueSummarySchema.parse({
        id: UUID,
        projectId: UUID,
        type: "exception",
        title: "Boom",
        normalizedMessage: "Boom",
        status: "open",
        severity: "error",
        assignee: null,
        firstSeenAt: ISO,
        lastSeenAt: ISO,
        resolvedAt: null,
        firstRelease: null,
        lastRelease: null,
        occurrenceCount: -1,
        affectedSessionCount: 0,
        tags: [],
        createdAt: ISO,
        updatedAt: ISO,
      }),
    ).toThrow();
  });

  it("applies list defaults and bounds the page size", () => {
    const parsed = issueListQuerySchema.parse({});
    expect(parsed.sort).toBe("last_seen");
    expect(parsed.order).toBe("desc");
    expect(parsed.limit).toBe(25);
    expect(() => issueListQuerySchema.parse({ limit: 101 })).toThrow();
    expect(
      issueListQuerySchema.parse({ unassigned: true, limit: 100 }).unassigned,
    ).toBe(true);
  });

  it("accepts assignee updates with explicit null for unassignment", () => {
    expect(updateIssueAssigneeRequestSchema.parse({ userId: null })).toEqual({
      userId: null,
    });
    expect(
      updateIssueAssigneeRequestSchema.parse({ userId: UUID }).userId,
    ).toBe(UUID);
    expect(() => updateIssueAssigneeRequestSchema.parse({})).toThrow();
  });

  it("validates activity rows with safe metadata only", () => {
    const parsed = issueActivitySchema.parse({
      id: UUID,
      issueId: UUID,
      type: "status_changed",
      actor: USER,
      metadata: { from: "open", to: "resolved" },
      createdAt: ISO,
    });
    expect(parsed.metadata).toEqual({ from: "open", to: "resolved" });
    expect(() =>
      issueActivitySchema.parse({
        id: UUID,
        issueId: UUID,
        type: "hacked",
        actor: null,
        metadata: {},
        createdAt: ISO,
      }),
    ).toThrow();
  });

  it("bounds comment bodies and carries author summaries", () => {
    const parsed = issueCommentSchema.parse({
      id: UUID,
      issueId: UUID,
      author: USER,
      bodyMarkdown: "Looks like a race.",
      createdAt: ISO,
      updatedAt: ISO,
    });
    expect(parsed.author.email).toBe("dev@example.com");
    expect(() => createCommentRequestSchema.parse({ body: "   " })).toThrow();
    expect(() =>
      createCommentRequestSchema.parse({ body: "x".repeat(10_001) }),
    ).toThrow();
  });

  it("normalizes tag creation input", () => {
    expect(createTagRequestSchema.parse({ name: "  Frontend " }).name).toBe(
      "Frontend",
    );
    expect(() => createTagRequestSchema.parse({ name: "" })).toThrow();
  });
});

describe("session contracts", () => {
  it("exposes session metadata without host identifiers", () => {
    const parsed = telemetrySessionSchema.parse({
      id: UUID,
      projectId: UUID,
      environment: "production",
      release: "web@1.0.0",
      startedAt: ISO,
      lastSeenAt: ISO,
      initialUrl: "https://example.com/",
      browserName: "Chrome",
      browserVersion: "126",
      osName: "Linux",
      osVersion: null,
      deviceType: "desktop",
      viewportWidth: 1280,
      viewportHeight: 800,
      sdkVersion: "0.1.0",
      sdkSessionId: "raw-sdk-id",
      anonymousUserHash: "hash",
    });
    expect(parsed).not.toHaveProperty("sdkSessionId");
    expect(parsed).not.toHaveProperty("anonymousUserHash");
  });

  it("defaults session list ordering to last_seen desc", () => {
    expect(sessionListQuerySchema.parse({}).order).toBe("desc");
  });

  it("requires a plain-text summary on timeline entries", () => {
    const parsed = sessionEventSchema.parse({
      id: UUID,
      sequenceNumber: 7,
      eventType: "network",
      occurredAt: ISO,
      receivedAt: ISO,
      environment: "production",
      release: null,
      pageUrl: "https://example.com/",
      processingState: "processed",
      summary: "GET https://example.com/ → 500",
    });
    expect(parsed.summary).toContain("500");
    expect(() =>
      sessionEventSchema.parse({
        id: UUID,
        sequenceNumber: 7,
        eventType: "network",
        occurredAt: ISO,
        receivedAt: ISO,
        environment: "production",
        release: null,
        pageUrl: "https://example.com/",
        processingState: "processed",
      }),
    ).toThrow();
  });
});

describe("notification contracts", () => {
  it("accepts regression and assignment notifications", () => {
    for (const type of ["issue_regression", "issue_assigned"] as const) {
      const parsed = notificationSchema.parse({
        id: UUID,
        type,
        title: "Title",
        body: "Body",
        projectId: UUID,
        issueId: UUID,
        readAt: null,
        createdAt: ISO,
      });
      expect(parsed.type).toBe(type);
    }
  });

  it("defaults the list to all notifications", () => {
    expect(notificationListQuerySchema.parse({}).unreadOnly).toBe(false);
  });
});

describe("metrics contracts", () => {
  it("defaults the metrics range to 7d", () => {
    expect(metricsQuerySchema.parse({}).range).toBe("7d");
    expect(() => metricsQuerySchema.parse({ range: "90d" })).toThrow();
  });

  it("accepts a full metrics payload", () => {
    const parsed = projectMetricsSchema.parse({
      range: "7d",
      bucketStart: ISO,
      bucketEnd: ISO,
      bucketSize: "daily",
      unresolvedCount: 4,
      newIssueCount: 2,
      occurrenceCount: 10,
      affectedSessionCount: 7,
      regressionCount: 1,
      topIssues: [{ issueId: UUID, title: "Boom", occurrences: 6 }],
      overTime: [{ bucketStart: ISO, occurrences: 6, newIssues: 1 }],
      byEnvironment: [{ key: "production", occurrences: 10 }],
      byRelease: [{ key: "web@1.0.0", occurrences: 10 }],
    });
    expect(parsed.topIssues).toHaveLength(1);
  });
});

describe("occurrence and event contracts", () => {
  it("accepts an occurrence without payload fields", () => {
    const parsed = occurrenceSchema.parse({
      eventId: UUID,
      sessionId: UUID,
      occurredAt: ISO,
      receivedAt: ISO,
      environment: "production",
      release: "web@1.0.0",
      pageUrl: "https://example.com/",
      eventType: "exception",
      processingState: "processed",
    });
    expect(parsed).not.toHaveProperty("payload_json");
    expect(occurrenceListQuerySchema.parse({}).limit).toBe(25);
  });

  it("parses an exception event detail and strips unknown keys", () => {
    const parsed = eventDetailSchema.parse({
      eventId: UUID,
      sessionId: UUID,
      issueId: UUID,
      eventType: "exception",
      occurredAt: ISO,
      receivedAt: ISO,
      environment: "production",
      release: null,
      pageUrl: null,
      processingState: "processed",
      data: {
        values: [
          {
            type: "TypeError",
            value: "boom",
            stacktrace: {
              frames: [{ filename: "app.js", lineno: 1 }],
            },
          },
        ],
        mechanism: { type: "onerror" },
        fingerprint: ["override"],
      },
    });
    expect(parsed.eventType).toBe("exception");
    if (parsed.eventType === "exception") {
      expect(parsed.data.values[0]?.type).toBe("TypeError");
      expect(parsed.data).not.toHaveProperty("mechanism");
      expect(parsed.data).not.toHaveProperty("fingerprint");
    }
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      eventDetailSchema.parse({
        eventId: UUID,
        sessionId: UUID,
        issueId: null,
        eventType: "poltergeist",
        occurredAt: ISO,
        receivedAt: ISO,
        environment: "production",
        release: null,
        pageUrl: null,
        processingState: "processed",
        data: {},
      }),
    ).toThrow();
  });
});

describe("activity and member contracts", () => {
  it("bounds the activity listing", () => {
    expect(activityListQuerySchema.parse({}).limit).toBe(50);
    expect(() => activityListQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it("accepts a minimal workspace member and rejects role escalation", () => {
    expect(
      workspaceMemberSchema.parse({
        id: "user-1",
        name: "Dev",
        email: "dev@example.com",
        role: "member",
      }),
    ).toMatchObject({ role: "member" });
    expect(() =>
      workspaceMemberSchema.parse({
        id: "user-1",
        name: "Dev",
        email: "dev@example.com",
        role: "superadmin",
      }),
    ).toThrow();
  });
});
