import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_PER_SUBSCRIBER,
  SSE_HEARTBEAT_MS,
  createProjectUpdatesBroker,
  validateProjectUpdate,
} from "./broker.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";

describe("validateProjectUpdate", () => {
  it("accepts worker-shaped payloads with an event id", () => {
    expect(
      validateProjectUpdate({
        version: 1,
        type: "issue.regressed",
        projectId: PROJECT,
        issueId: ISSUE,
        eventId: EVENT,
      }),
    ).toEqual({
      version: 1,
      type: "issue.regressed",
      projectId: PROJECT,
      issueId: ISSUE,
      eventId: EVENT,
    });
  });

  it("accepts mutation-shaped payloads without an event id", () => {
    for (const type of [
      "issue.updated",
      "comment.created",
      "assignment.changed",
      "tags.changed",
    ]) {
      expect(
        validateProjectUpdate({
          version: 1,
          type,
          projectId: PROJECT,
          issueId: ISSUE,
        }),
      ).toMatchObject({ version: 1, type, projectId: PROJECT });
    }
  });

  it("drops everything malformed without throwing", () => {
    const bad = [
      null,
      undefined,
      42,
      "not-json-shape",
      {},
      { version: 2, type: "issue.updated", projectId: PROJECT, issueId: ISSUE },
      { version: 1, type: "issue.deleted", projectId: PROJECT, issueId: ISSUE },
      { version: 1, type: "issue.updated", projectId: "x", issueId: ISSUE },
      {
        version: 1,
        type: "issue.updated",
        projectId: PROJECT,
        issueId: ISSUE,
        eventId: "nope",
      },
      {
        version: 1,
        type: "issue.updated",
        projectId: PROJECT,
        issueId: ISSUE,
        payload_json: { secrets: true },
      },
    ];
    for (const candidate of bad) {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "payload_json" in candidate
      ) {
        // Extra keys are tolerated but never forwarded.
        expect(validateProjectUpdate(candidate)).toMatchObject({
          version: 1,
          type: "issue.updated",
        });
      } else {
        expect(validateProjectUpdate(candidate)).toBeNull();
      }
    }
  });

  it("exposes sane realtime bounds", () => {
    expect(SSE_HEARTBEAT_MS).toBeGreaterThanOrEqual(20_000);
    expect(SSE_HEARTBEAT_MS).toBeLessThanOrEqual(30_000);
    expect(MAX_PENDING_PER_SUBSCRIBER).toBeLessThanOrEqual(100);
  });

  it("degrades cleanly when LISTEN is unreachable (no throw, no hang)", async () => {
    const broker = createProjectUpdatesBroker({
      connectionString:
        "postgres://replaybug:replaybug@localhost:5599/replaybug",
    });
    try {
      const ready = await broker.whenReady(1500);
      expect(ready).toBe(false);
      // Subscribing without a connection never throws; updates queue nowhere.
      const received: unknown[] = [];
      const unsubscribe = broker.subscribe(PROJECT, (update) => {
        received.push(update);
      });
      expect(broker.subscriberCount(PROJECT)).toBe(1);
      unsubscribe();
      expect(broker.subscriberCount()).toBe(0);
      expect(received).toHaveLength(0);
    } finally {
      await broker.stop();
    }
  }, 15000);
});
