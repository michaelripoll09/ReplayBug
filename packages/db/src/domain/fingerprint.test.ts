import { describe, expect, it } from "vitest";
import {
  StoredEventPayloadError,
  buildFingerprintSignature,
  deriveEventProcessingPlan,
  hashFingerprint,
  normalizeCustomFingerprint,
} from "./fingerprint.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function exceptionPlan(
  payload: Record<string, unknown>,
  projectId = PROJECT_ID,
): ReturnType<typeof deriveEventProcessingPlan> {
  return deriveEventProcessingPlan({
    projectId,
    eventType: "exception",
    payload,
  });
}

function descriptorOf(plan: ReturnType<typeof deriveEventProcessingPlan>) {
  if (plan.kind !== "issue") {
    throw new Error("expected an issue plan");
  }
  return plan.descriptor;
}

function exceptionPayload(overrides: {
  type?: string;
  value: string;
  frames?: Array<Record<string, unknown>>;
  fingerprint?: string[];
}): Record<string, unknown> {
  return {
    values: [
      {
        type: overrides.type ?? "TypeError",
        value: overrides.value,
        stacktrace: overrides.frames ? { frames: overrides.frames } : undefined,
      },
    ],
    fingerprint: overrides.fingerprint,
  };
}

describe("exception fingerprints", () => {
  it("groups the same defect with different UUIDs", () => {
    const first = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "Cannot load order 550e8400-e29b-41d4-a716-446655440000",
        }),
      ),
    );
    const second = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "Cannot load order 9c858901-8a57-4791-81fe-4c455b099bc9",
        }),
      ),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.title).toBe("TypeError: Cannot load order :id");
  });

  it("groups the same defect with different long ids", () => {
    const first = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "User 7192381 not found" })),
    );
    const second = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "User 8831921 not found" })),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("does not include the release in the descriptor inputs", () => {
    // The derive input has no release field at all: two occurrences of the
    // same defect in different releases derive identical fingerprints.
    const descriptor = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "Boom" })),
    );
    expect(descriptor.signature).not.toContain("release");
  });

  it("separates different exception classes", () => {
    const first = descriptorOf(
      exceptionPlan(exceptionPayload({ type: "TypeError", value: "Boom" })),
    );
    const second = descriptorOf(
      exceptionPlan(exceptionPayload({ type: "RangeError", value: "Boom" })),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("separates meaningful stack differences", () => {
    const framesA = [
      {
        filename: "/src/checkout.ts",
        function: "pay",
        lineno: 10,
        in_app: true,
      },
    ];
    const framesB = [
      { filename: "/src/cart.ts", function: "add", lineno: 22, in_app: true },
    ];
    const first = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "Boom", frames: framesA })),
    );
    const second = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "Boom", frames: framesB })),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("groups identical stacks regardless of column numbers", () => {
    const first = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "Boom",
          frames: [
            {
              filename: "/src/App.tsx",
              function: "App",
              lineno: 10,
              colno: 1,
              in_app: true,
            },
          ],
        }),
      ),
    );
    const second = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "Boom",
          frames: [
            {
              filename: "/src/App.tsx",
              function: "App",
              lineno: 10,
              colno: 77,
              in_app: true,
            },
          ],
        }),
      ),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("produces a stable fingerprint without a stack", () => {
    const first = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "No stack here" })),
    );
    const second = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "No stack here" })),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.grouping).toBe("automatic");
  });

  it("keeps the canonical signature as collision diagnostics", () => {
    const descriptor = descriptorOf(
      exceptionPlan(exceptionPayload({ value: "Cannot load user 7192381" })),
    );
    expect(descriptor.signature).toContain("Cannot load user :id");
    expect(descriptor.signature.startsWith("[")).toBe(true);
  });
});

describe("custom fingerprints", () => {
  it("groups equal custom arrays even with different messages", () => {
    const first = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "First failure message",
          fingerprint: ["checkout", "payment-step"],
        }),
      ),
    );
    const second = descriptorOf(
      exceptionPlan(
        exceptionPayload({
          value: "Completely different message",
          fingerprint: ["checkout", "payment-step"],
        }),
      ),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.grouping).toBe("custom");
  });

  it("separates different custom arrays", () => {
    const first = descriptorOf(
      exceptionPlan(
        exceptionPayload({ value: "Boom", fingerprint: ["group-a"] }),
      ),
    );
    const second = descriptorOf(
      exceptionPlan(
        exceptionPayload({ value: "Boom", fingerprint: ["group-b"] }),
      ),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("keeps the same custom array in different projects apart", () => {
    const payloadA = exceptionPayload({
      value: "Boom",
      fingerprint: ["checkout"],
    });
    const payloadB = exceptionPayload({
      value: "Boom",
      fingerprint: ["checkout"],
    });
    const first = descriptorOf(exceptionPlan(payloadA, PROJECT_ID));
    const second = descriptorOf(exceptionPlan(payloadB, OTHER_PROJECT_ID));
    expect(first.signature).toBe(second.signature);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("falls back to the automatic fingerprint when the custom array is unusable", () => {
    const descriptor = descriptorOf(
      exceptionPlan(
        exceptionPayload({ value: "Boom", fingerprint: ["", "   "] }),
      ),
    );
    expect(descriptor.grouping).toBe("automatic");
  });

  it("bounds custom fingerprint items", () => {
    const items = normalizeCustomFingerprint([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
    expect(items).toHaveLength(5);
  });
});

describe("network fingerprints", () => {
  function networkPlan(payload: Record<string, unknown>) {
    return deriveEventProcessingPlan({
      projectId: PROJECT_ID,
      eventType: "network",
      payload,
    });
  }

  function networkPayload(overrides: {
    url: string;
    method?: string;
    status?: number | null;
    failureType?: string;
  }): Record<string, unknown> {
    return {
      url: overrides.url,
      method: overrides.method ?? "GET",
      status_code: overrides.status === undefined ? 500 : overrides.status,
      duration_ms: 12,
      request_started_at: "2026-09-17T12:00:00.000Z",
      failure_type: overrides.failureType,
    };
  }

  it("groups the same route with different entity ids", () => {
    const first = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/api/users/7192381" }),
      ),
    );
    const second = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/api/users/8831921" }),
      ),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.title).toBe("GET /api/users/:id → 500");
  });

  it("separates different HTTP methods", () => {
    const first = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/users", method: "GET" }),
      ),
    );
    const second = descriptorOf(
      networkPlan(
        networkPayload({
          url: "https://api.example.com/users",
          method: "POST",
        }),
      ),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("separates different status categories", () => {
    const first = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/users", status: 500 }),
      ),
    );
    const second = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/users", status: 404 }),
      ),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("ignores query strings", () => {
    const first = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/users?page=1" }),
      ),
    );
    const second = descriptorOf(
      networkPlan(
        networkPayload({ url: "https://api.example.com/users?page=2" }),
      ),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("uses the failure category when there is no status", () => {
    const descriptor = descriptorOf(
      networkPlan(
        networkPayload({
          url: "https://api.example.com/users",
          status: null,
          failureType: "timeout",
        }),
      ),
    );
    expect(descriptor.title).toBe("GET /users → timeout");
  });

  it("treats successful network events as non-issues", () => {
    const plan = networkPlan(
      networkPayload({ url: "https://api.example.com/ok", status: 200 }),
    );
    expect(plan.kind).toBe("non_issue");
  });
});

describe("console and message fingerprints", () => {
  it("groups console errors with unstable args normalized", () => {
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "console_error",
        payload: { args: ["Payment initialization failed", "user 7192381"] },
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "console_error",
        payload: { args: ["Payment initialization failed", "user 8831921"] },
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.title).toBe(
      "Console error: Payment initialization failed user :id",
    );
  });

  it("creates issues for warning and error messages", () => {
    const warning = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "message",
        payload: { message: "Payment initialization failed", level: "warning" },
      }),
    );
    expect(warning.severity).toBe("warning");
    expect(warning.title).toBe("Warning: Payment initialization failed");

    const error = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "message",
        payload: { message: "Payment initialization failed", level: "error" },
      }),
    );
    expect(error.severity).toBe("error");
    expect(error.fingerprint).not.toBe(warning.fingerprint);
  });

  it("treats info and debug messages as non-issues", () => {
    for (const level of ["info", "debug"] as const) {
      const plan = deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "message",
        payload: { message: "just logging", level },
      });
      expect(plan.kind).toBe("non_issue");
    }
  });

  it("groups unhandled rejections by normalized reason", () => {
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "unhandled_rejection",
        payload: { reason: "Failed to load profile 7192381" },
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "unhandled_rejection",
        payload: { reason: "Failed to load profile 8831921" },
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.title).toBe("Unhandled rejection: Failed to load profile :id");
  });
});

describe("non-issue event types", () => {
  it("classifies breadcrumbs and sdk events as non-issues", () => {
    for (const eventType of [
      "navigation",
      "click",
      "input",
      "custom_breadcrumb",
      "sdk",
    ] as const) {
      const plan = deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType,
        payload: {},
      });
      expect(plan.kind).toBe("non_issue");
    }
  });
});

describe("malformed stored payloads", () => {
  it("flags malformed exception payloads deterministically", () => {
    expect(() =>
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: { nope: true },
      }),
    ).toThrowError(StoredEventPayloadError);
    try {
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: { nope: true },
      });
    } catch (error) {
      expect((error as StoredEventPayloadError).code).toBe("malformed_payload");
    }
  });

  it("flags unknown stored event types deterministically", () => {
    try {
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "totally_unknown",
        payload: {},
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as StoredEventPayloadError).code).toBe(
        "unsupported_event_type",
      );
    }
  });
});

describe("hash format", () => {
  it("is deterministic and 64 lowercase hex characters", () => {
    const signature = buildFingerprintSignature(["exception", "TypeError"]);
    const first = hashFingerprint(PROJECT_ID, signature);
    const second = hashFingerprint(PROJECT_ID, signature);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the project namespace", () => {
    const signature = buildFingerprintSignature(["exception", "TypeError"]);
    expect(hashFingerprint(PROJECT_ID, signature)).not.toBe(
      hashFingerprint(OTHER_PROJECT_ID, signature),
    );
  });

  it("serializes arrays stably", () => {
    const signature = buildFingerprintSignature([
      "exception",
      "TypeError",
      "Boom",
      "fn@/src/App.tsx:10",
    ]);
    expect(signature).toBe(
      '["exception","TypeError","Boom","fn@/src/App.tsx:10"]',
    );
  });
});
