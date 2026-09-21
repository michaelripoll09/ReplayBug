import { describe, expect, it } from "vitest";
import { deriveEventProcessingPlan } from "./fingerprint.js";
import type { NormalizableStackFrame } from "./normalize.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function descriptorOf(
  plan: ReturnType<typeof deriveEventProcessingPlan>,
): Extract<
  ReturnType<typeof deriveEventProcessingPlan>,
  { kind: "issue" }
>["descriptor"] {
  if (plan.kind !== "issue") {
    throw new Error("expected an issue plan");
  }
  return plan.descriptor;
}

function exceptionPayload(
  value: string,
  frames: Array<Record<string, unknown>>,
  fingerprint?: string[],
): Record<string, unknown> {
  return {
    values: [
      {
        type: "TypeError",
        value,
        stacktrace: { frames },
      },
    ],
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

const RAW_A: Array<Record<string, unknown>> = [
  {
    filename: "https://cdn.example.com/assets/app-AAA.js",
    function: "a",
    lineno: 1,
    colno: 100,
    in_app: true,
  },
];

const RAW_B: Array<Record<string, unknown>> = [
  {
    filename: "https://cdn.example.com/assets/app-BBB.js",
    function: "a",
    lineno: 1,
    colno: 928,
    in_app: true,
  },
];

const MAPPED_CHECKOUT: readonly NormalizableStackFrame[] = [
  {
    filename: "src/features/checkout/CheckoutButton.tsx",
    function: "a",
    lineno: 84,
    colno: 1,
    in_app: true,
  },
];

const MAPPED_CART: readonly NormalizableStackFrame[] = [
  {
    filename: "src/features/cart/CartView.tsx",
    function: "a",
    lineno: 84,
    colno: 1,
    in_app: true,
  },
];

describe("mapped fingerprint derivation (RS-09)", () => {
  it("groups different generated files/coords mapping to the same source", () => {
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload(
          "Cannot read properties of null (reading 'total')",
          RAW_A,
        ),
        mappedFrames: MAPPED_CHECKOUT,
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload(
          "Cannot read properties of null (reading 'total')",
          RAW_B,
        ),
        mappedFrames: MAPPED_CHECKOUT,
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.signature).toContain(
      "src/features/checkout/CheckoutButton.tsx:84",
    );
    expect(first.signature).not.toContain("app-AAA");
    expect(first.signature).not.toContain("app-BBB");
  });

  it("differs from the raw-only fingerprint (mapped wins over generated hash)", () => {
    const rawOnly = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload(
          "Cannot read properties of null (reading 'total')",
          RAW_A,
        ),
      }),
    );
    const mapped = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload(
          "Cannot read properties of null (reading 'total')",
          RAW_A,
        ),
        mappedFrames: MAPPED_CHECKOUT,
      }),
    );
    expect(mapped.fingerprint).not.toBe(rawOnly.fingerprint);
  });

  it("separates different original source locations", () => {
    const checkout = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
        mappedFrames: MAPPED_CHECKOUT,
      }),
    );
    const cart = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
        mappedFrames: MAPPED_CART,
      }),
    );
    expect(checkout.fingerprint).not.toBe(cart.fingerprint);
  });

  it("lets an explicit custom fingerprint override mapped selection", () => {
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("first distinct message", RAW_A, [
          "checkout",
          "payment-step",
        ]),
        mappedFrames: MAPPED_CHECKOUT,
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("second distinct message", RAW_B, [
          "checkout",
          "payment-step",
        ]),
        mappedFrames: MAPPED_CART,
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.grouping).toBe("custom");
    expect(first.signature).toContain('"custom"');
  });

  it("falls back to the raw sanitized path when no mapped frames are given", () => {
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.grouping).toBe("automatic");
  });

  it("ignores mapped frames without an in-application frame (raw path unchanged)", () => {
    const nonInApp: readonly NormalizableStackFrame[] = [
      {
        filename: "src/features/checkout/CheckoutButton.tsx",
        function: "a",
        lineno: 84,
        colno: 1,
        in_app: false,
      },
    ];
    const withMapped = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
        mappedFrames: nonInApp,
      }),
    );
    const rawOnly = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
      }),
    );
    expect(withMapped.fingerprint).toBe(rawOnly.fingerprint);
  });

  it("is deterministic for partial mapped input (mapped + raw fallback)", () => {
    const partial: readonly NormalizableStackFrame[] = [
      {
        filename: "src/features/checkout/CheckoutButton.tsx",
        function: "a",
        lineno: 84,
        colno: 1,
        in_app: true,
      },
      {
        filename: "https://cdn.example.com/assets/missing.js",
        function: "b",
        lineno: 5,
        colno: 5,
        in_app: true,
      },
    ];
    const first = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
        mappedFrames: partial,
      }),
    );
    const second = descriptorOf(
      deriveEventProcessingPlan({
        projectId: PROJECT_ID,
        eventType: "exception",
        payload: exceptionPayload("Boom", RAW_A),
        mappedFrames: partial,
      }),
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.signature).toContain("CheckoutButton.tsx:84");
  });
});
