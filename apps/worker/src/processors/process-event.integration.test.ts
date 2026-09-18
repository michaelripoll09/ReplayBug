import { Client } from "pg";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@replaybug/observability";
import { PROJECT_UPDATES_CHANNEL } from "@replaybug/db";
import type { DbClient } from "@replaybug/db";
import { processEvent } from "./process-event.js";
import { createProcessEventJobHandler } from "./process-event-handler.js";
import {
  countIssuesByProject,
  createWorkerTestDatabase,
  exceptionPayload,
  insertTestEvent,
  readActivityRows,
  readAffectedSessionRows,
  readEventRow,
  readIssueRow,
  readIssuesByProject,
  readNotificationRows,
  readOutboxRow,
  seedProject,
  waitFor,
  type WorkerTestDatabase,
} from "../test-helpers.js";

/**
 * Event → issue processing against real PostgreSQL (isolated temp database).
 * Covers creation, grouping, aggregates, concurrency, regression, ignored,
 * ordering, rejection and NOTIFY semantics from the Block 5 scope.
 */

let testDb: WorkerTestDatabase;
let client: DbClient;

beforeAll(async () => {
  testDb = await createWorkerTestDatabase();
  client = testDb.client;
});

afterAll(async () => {
  await testDb.drop();
});

const FRAMES = [
  {
    filename: "http://localhost:5173/src/App.tsx",
    function: "triggerJsException",
    lineno: 69,
    colno: 11,
    in_app: true,
  },
];

function standardPayload(
  value = "Cannot read properties of null (reading 'total')",
) {
  return exceptionPayload(value, { frames: FRAMES });
}

describe("event → issue creation", () => {
  it("creates exactly one open issue and marks the event processed", async () => {
    const project = await seedProject(client);
    const { eventId, sessionId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      release: "demo@1.0.0",
    });

    const outcome = await processEvent({ db: client.db }, eventId);
    expect(outcome.status).toBe("processed");
    if (outcome.status !== "processed") throw new Error("unreachable");
    expect(outcome.issueId).not.toBeNull();
    const issueId = outcome.issueId ?? "";

    const event = await readEventRow(client, eventId);
    expect(event?.processing_state).toBe("processed");
    expect(event?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(event?.issue_id).toBe(issueId);

    const issue = await readIssueRow(client, issueId);
    expect(issue?.status).toBe("open");
    expect(issue?.type).toBe("exception");
    expect(issue?.severity).toBe("error");
    expect(issue?.occurrence_count).toBe(1);
    expect(issue?.affected_session_count).toBe(1);
    expect(issue?.resolved_at).toBeNull();
    expect(issue?.first_release).toBe("demo@1.0.0");
    expect(issue?.last_release).toBe("demo@1.0.0");
    expect(issue?.title).toBe(
      "TypeError: Cannot read properties of null (reading 'total')",
    );
    expect(issue?.fingerprint_signature).toContain(
      "triggerJsException@/src/App.tsx:69",
    );

    const relations = await readAffectedSessionRows(client, issueId);
    expect(relations).toEqual([
      { issue_id: issueId, telemetry_session_id: sessionId },
    ]);

    const activity = await readActivityRows(client, issueId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.type).toBe("created");
    expect(activity[0]?.actor_user_id).toBeNull();
    expect(activity[0]?.metadata_json).toEqual({ eventId });

    // The outbox row is preserved for inspection: dispatched_at only means
    // "handed to pg-boss", never "processed".
    const outbox = await readOutboxRow(client, eventId);
    expect(outbox).toBeDefined();
    expect(outbox?.dispatched_at).toBeNull();
  });
});

describe("repeated events and aggregates", () => {
  it("groups two events with the same fingerprint into one issue", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(
        "Cannot read properties of null (reading 'total')",
      ),
    });

    await processEvent({ db: client.db }, first.eventId);
    await processEvent({ db: client.db }, second.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue?.occurrence_count).toBe(2);
    expect(issue?.affected_session_count).toBe(2);

    const firstEvent = await readEventRow(client, first.eventId);
    const secondEvent = await readEventRow(client, second.eventId);
    expect(firstEvent?.issue_id).toBe(secondEvent?.issue_id);
    expect(firstEvent?.fingerprint).toBe(secondEvent?.fingerprint);

    const activity = await readActivityRows(client, issue?.id ?? "");
    expect(activity.filter((row) => row.type === "created")).toHaveLength(1);
    const notifications = await readNotificationRows(client, issue?.id ?? "");
    expect(notifications).toHaveLength(0);
  });

  it("counts a session once even with multiple occurrences", async () => {
    const project = await seedProject(client);
    const sdkSessionId = "same-session-47";
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      sdkSessionId,
    });
    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      sdkSessionId,
    });

    await processEvent({ db: client.db }, first.eventId);
    await processEvent({ db: client.db }, second.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(issues[0]?.affected_session_count).toBe(1);
  });

  it("counts distinct sessions: A, B, B → 2 affected sessions", async () => {
    const project = await seedProject(client);
    const sessionA = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      sdkSessionId: "session-A-48",
    });
    const sessionB1 = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      sdkSessionId: "session-B-48",
    });
    const sessionB2 = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      sdkSessionId: "session-B-48",
    });

    await processEvent({ db: client.db }, sessionA.eventId);
    await processEvent({ db: client.db }, sessionB1.eventId);
    await processEvent({ db: client.db }, sessionB2.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues[0]?.occurrence_count).toBe(3);
    expect(issues[0]?.affected_session_count).toBe(2);
  });

  it("does not include the release in the fingerprint", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      release: "demo@1.0.0",
    });
    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      release: "demo@2.0.0",
    });

    await processEvent({ db: client.db }, first.eventId);
    await processEvent({ db: client.db }, second.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
  });
});

describe("concurrency", () => {
  it("groups 10 concurrent same-fingerprint events into one exact issue", async () => {
    const project = await seedProject(client);
    const events = [];
    for (let index = 0; index < 10; index++) {
      events.push(
        await insertTestEvent(client, {
          projectId: project.projectId,
          eventType: "exception",
          payload: standardPayload(),
          sdkSessionId: `concurrent-session-${index}`,
        }),
      );
    }

    const outcomes = await Promise.all(
      events.map((event) => processEvent({ db: client.db }, event.eventId)),
    );
    expect(outcomes.every((outcome) => outcome.status === "processed")).toBe(
      true,
    );

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue?.occurrence_count).toBe(10);
    expect(issue?.affected_session_count).toBe(10);

    const issueIds = new Set<string>();
    for (const event of events) {
      const row = await readEventRow(client, event.eventId);
      expect(row?.processing_state).toBe("processed");
      expect(row?.issue_id).toBe(issue?.id);
      issueIds.add(row?.issue_id ?? "");
    }
    expect(issueIds.size).toBe(1);

    const activity = await readActivityRows(client, issue?.id ?? "");
    expect(activity.filter((row) => row.type === "created")).toHaveLength(1);
    const relations = await readAffectedSessionRows(client, issue?.id ?? "");
    expect(relations).toHaveLength(10);
  });

  it("processes the same event concurrently exactly once", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => processEvent({ db: client.db }, eventId)),
    );
    const processed = outcomes.filter((o) => o.status === "processed");
    const already = outcomes.filter((o) => o.status === "already-processed");
    expect(processed).toHaveLength(1);
    expect(already).toHaveLength(4);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
    expect(issues[0]?.affected_session_count).toBe(1);

    const activity = await readActivityRows(client, issues[0]?.id ?? "");
    expect(activity).toHaveLength(1);
    const notifications = await readNotificationRows(
      client,
      issues[0]?.id ?? "",
    );
    expect(notifications).toHaveLength(0);
  });

  it("is a no-op when a job is delivered twice after a successful commit", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });

    const first = await processEvent({ db: client.db }, eventId);
    expect(first.status).toBe("processed");
    const second = await processEvent({ db: client.db }, eventId);
    expect(second.status).toBe("already-processed");

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(1);
    expect(issues[0]?.affected_session_count).toBe(1);
    const activity = await readActivityRows(client, issues[0]?.id ?? "");
    expect(activity).toHaveLength(1);
  });
});

describe("regression, ignored and investigating", () => {
  it("reopens a resolved issue once and notifies the assignee once", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, first.eventId);
    const issues = await readIssuesByProject(client, project.projectId);
    const issueId = issues[0]?.id ?? "";

    await client.pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now(), assigned_to_user_id = $2 WHERE id = $1`,
      [issueId, project.userId],
    );

    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      release: "demo@1.0.1",
    });
    await processEvent({ db: client.db }, second.eventId);
    // Retry of the same job must not duplicate the regression activity.
    await processEvent({ db: client.db }, second.eventId);

    const issue = await readIssueRow(client, issueId);
    expect(issue?.status).toBe("open");
    expect(issue?.resolved_at).toBeNull();
    expect(issue?.occurrence_count).toBe(2);
    expect(issue?.last_release).toBe("demo@1.0.1");

    const activity = await readActivityRows(client, issueId);
    expect(activity.map((row) => row.type).sort()).toEqual([
      "created",
      "regression_detected",
    ]);

    const notifications = await readNotificationRows(client, issueId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("issue_regression");
    expect(notifications[0]?.user_id).toBe(project.userId);
    expect(notifications[0]?.workspace_id).toBe(project.workspaceId);
    expect(notifications[0]?.read_at).toBeNull();
  });

  it("does not notify when a resolved issue has no assignee", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, first.eventId);
    const issueId =
      (await readIssuesByProject(client, project.projectId))[0]?.id ?? "";
    await client.pool.query(
      `UPDATE issues SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [issueId],
    );

    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, second.eventId);

    const activity = await readActivityRows(client, issueId);
    expect(
      activity.filter((row) => row.type === "regression_detected"),
    ).toHaveLength(1);
    const notifications = await readNotificationRows(client, issueId);
    expect(notifications).toHaveLength(0);
  });

  it("keeps ignored issues ignored while counters and last-seen update", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, first.eventId);
    const issueId =
      (await readIssuesByProject(client, project.projectId))[0]?.id ?? "";
    await client.pool.query(
      `UPDATE issues SET status = 'ignored' WHERE id = $1`,
      [issueId],
    );

    const later = new Date(Date.now() + 60_000);
    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      occurredAt: later,
      release: "demo@1.0.2",
    });
    await processEvent({ db: client.db }, second.eventId);

    const issue = await readIssueRow(client, issueId);
    expect(issue?.status).toBe("ignored");
    expect(issue?.occurrence_count).toBe(2);
    expect(issue?.affected_session_count).toBe(2);
    expect(issue?.last_release).toBe("demo@1.0.2");
    expect(new Date(issue?.last_seen_at ?? 0).getTime()).toBe(later.getTime());

    const activity = await readActivityRows(client, issueId);
    expect(
      activity.filter((row) => row.type === "regression_detected"),
    ).toHaveLength(0);
    const notifications = await readNotificationRows(client, issueId);
    expect(notifications).toHaveLength(0);
  });

  it("keeps investigating issues investigating", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, first.eventId);
    const issueId =
      (await readIssuesByProject(client, project.projectId))[0]?.id ?? "";
    await client.pool.query(
      `UPDATE issues SET status = 'investigating' WHERE id = $1`,
      [issueId],
    );

    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
    });
    await processEvent({ db: client.db }, second.eventId);

    const issue = await readIssueRow(client, issueId);
    expect(issue?.status).toBe("investigating");
    expect(issue?.occurrence_count).toBe(2);
    const activity = await readActivityRows(client, issueId);
    expect(
      activity.filter((row) => row.type === "regression_detected"),
    ).toHaveLength(0);
  });
});

describe("out-of-order events", () => {
  it("keeps first/last seen and first/last release correct", async () => {
    const project = await seedProject(client);
    const newer = new Date();
    const older = new Date(newer.getTime() - 60 * 60 * 1000);

    const newerEvent = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      occurredAt: newer,
      release: "demo@2.0.0",
    });
    const olderEvent = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: standardPayload(),
      occurredAt: older,
      release: "demo@1.0.0",
    });

    // Worker processes the newer event first: jobs are not ordered by time.
    await processEvent({ db: client.db }, newerEvent.eventId);
    await processEvent({ db: client.db }, olderEvent.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(new Date(issue?.first_seen_at ?? 0).getTime()).toBe(older.getTime());
    expect(new Date(issue?.last_seen_at ?? 0).getTime()).toBe(newer.getTime());
    expect(issue?.first_release).toBe("demo@1.0.0");
    expect(issue?.last_release).toBe("demo@2.0.0");
    expect(issue?.occurrence_count).toBe(2);
  });
});

describe("non-issue events", () => {
  it("processes breadcrumbs without creating issues", async () => {
    const project = await seedProject(client);
    const events = [];
    for (const eventType of ["navigation", "click", "input"] as const) {
      events.push(
        await insertTestEvent(client, {
          projectId: project.projectId,
          eventType,
          payload: {},
        }),
      );
    }

    for (const event of events) {
      const outcome = await processEvent({ db: client.db }, event.eventId);
      expect(outcome.status).toBe("processed");
    }

    for (const event of events) {
      const row = await readEventRow(client, event.eventId);
      expect(row?.processing_state).toBe("processed");
      expect(row?.issue_id).toBeNull();
      expect(row?.fingerprint).toBeNull();
    }
    expect(await countIssuesByProject(client, project.projectId)).toBe(0);
  });

  it("treats info-level messages as non-issues", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "message",
      payload: { message: "informational", level: "info" },
    });
    const outcome = await processEvent({ db: client.db }, eventId);
    expect(outcome.status).toBe("processed");
    expect(await countIssuesByProject(client, project.projectId)).toBe(0);
  });
});

describe("malformed stored events", () => {
  it("rejects deterministically instead of retrying forever", async () => {
    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: { values: "not-an-array" },
    });

    const outcome = await processEvent({ db: client.db }, eventId);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toBe("malformed_payload");

    const row = await readEventRow(client, eventId);
    expect(row?.processing_state).toBe("rejected");
    expect(row?.rejection_reason).toBe("malformed_payload");
    expect(row?.issue_id).toBeNull();
    expect(await countIssuesByProject(client, project.projectId)).toBe(0);

    // Re-processing a rejected event is a no-op.
    const second = await processEvent({ db: client.db }, eventId);
    expect(second.status).toBe("already-rejected");
  });

  it("acknowledges jobs for unknown events without failing", async () => {
    const outcome = await processEvent(
      { db: client.db },
      "00000000-0000-4000-8000-000000000000",
    );
    expect(outcome.status).toBe("event-not-found");
  });
});

describe("custom fingerprints", () => {
  it("groups different messages under the same custom fingerprint", async () => {
    const project = await seedProject(client);
    const first = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("first distinct message", {
        fingerprint: ["checkout", "payment-step"],
      }),
    });
    const second = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload("second distinct message", {
        fingerprint: ["checkout", "payment-step"],
      }),
    });

    await processEvent({ db: client.db }, first.eventId);
    await processEvent({ db: client.db }, second.eventId);

    const issues = await readIssuesByProject(client, project.projectId);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.occurrence_count).toBe(2);
    expect(issues[0]?.fingerprint_signature).toContain('"custom"');
  });
});

describe("worker logging", () => {
  it("never logs stored payload content", async () => {
    const chunks: string[] = [];
    const destination = {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    };
    const logger = createLogger({
      service: "worker-test",
      level: "info",
      destination,
    });

    const project = await seedProject(client);
    const { eventId } = await insertTestEvent(client, {
      projectId: project.projectId,
      eventType: "exception",
      payload: exceptionPayload(
        "SECRET_MARKER_VALUE_12345 crashed while loading",
      ),
    });

    const handler = createProcessEventJobHandler({ db: client.db, logger });
    await handler([
      {
        id: eventId,
        name: "replaybug.process-event",
        data: { version: 1, eventId },
      } as unknown as Job<unknown>,
    ]);

    const output = chunks.join("");
    expect(output).toContain("process-event completed");
    expect(output).toContain(eventId);
    expect(output).toContain(project.projectId);
    expect(output).not.toContain("SECRET_MARKER_VALUE_12345");
    expect(output).not.toContain("payloadJson");
  });
});

describe("PostgreSQL NOTIFY", () => {
  it("publishes the project update after the issue transaction commits", async () => {
    const project = await seedProject(client);
    const listener = new Client({ connectionString: testDb.databaseUrl });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (message) => {
      if (message.channel === PROJECT_UPDATES_CHANNEL && message.payload) {
        received.push(message.payload);
      }
    });
    await listener.query(`LISTEN ${PROJECT_UPDATES_CHANNEL}`);

    try {
      const { eventId } = await insertTestEvent(client, {
        projectId: project.projectId,
        eventType: "exception",
        payload: standardPayload(),
      });
      const outcome = await processEvent({ db: client.db }, eventId);
      expect(outcome.status).toBe("processed");

      const payload = await waitFor(() =>
        received.length > 0 ? received[0] : null,
      );
      expect(JSON.parse(payload ?? "{}")).toEqual({
        version: 1,
        type: "issue.created",
        projectId: project.projectId,
        issueId: outcome.status === "processed" ? outcome.issueId : null,
        eventId,
      });
    } finally {
      await listener.end();
    }
  });
});
