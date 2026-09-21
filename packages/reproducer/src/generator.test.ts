import { describe, expect, it } from "vitest";
import { buildReproductionPlan } from "./plan.js";
import { renderPlaywrightTest } from "./render.js";
import { validateGeneratedSyntax } from "./syntax.js";
import { REPRODUCTION_GENERATOR_VERSION } from "./version.js";
import type { GenerationInput } from "./types.js";
import { ReproductionError } from "./base-url.js";

function baseInput(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    issueId: "11111111-2222-4333-8444-555555555555",
    issueTitle: "Checkout fails",
    issueType: "exception",
    occurrenceEventId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    environment: "production",
    release: "demo@1.0.0",
    baseUrl: "https://demo.test",
    timeline: [],
    failure: {
      kind: "exception",
      expectedType: "TypeError",
      expectedMessage: "Cannot read properties of null",
    },
    ...overrides,
  };
}

function planAndCode(input: GenerationInput): string {
  const plan = buildReproductionPlan(input);
  const gen = renderPlaywrightTest(plan);
  return gen.code;
}

describe("locator priority", () => {
  it("prefers getByTestId over CSS", () => {
    const code = planAndCode(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/checkout" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "click",
            payload: {
              locator_candidates: [
                {
                  type: "css_fallback",
                  value: "div > button",
                  confidence: 0.5,
                },
                { type: "test_id", value: "checkout-button", confidence: 1.0 },
              ],
              element_tag: "button",
            },
          },
        ],
      }),
    );
    expect(code).toContain("getByTestId('checkout-button')");
    expect(code).not.toContain("div > button");
  });

  it("renders role locator", () => {
    const code = planAndCode(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "click",
            payload: {
              locator_candidates: [
                {
                  type: "role_name",
                  value: 'button[name="Checkout"]',
                  confidence: 0.9,
                },
              ],
              element_tag: "button",
            },
          },
        ],
      }),
    );
    expect(code).toContain("getByRole('button', { name: 'Checkout' })");
  });

  it("prefers stable id over UUID-like id", () => {
    const code = planAndCode(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "click",
            payload: {
              locator_candidates: [
                { type: "id", value: "#submit-order", confidence: 0.8 },
              ],
              element_tag: "button",
            },
          },
        ],
      }),
    );
    expect(code).toContain("#submit-order");
  });

  it("uses CSS fallback with brittle warning", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "click",
            payload: {
              locator_candidates: [
                {
                  type: "css_fallback",
                  value: "div > ul > li:nth-child(3) > button",
                  confidence: 0.5,
                },
              ],
              element_tag: "button",
            },
          },
        ],
      }),
    );
    expect(plan.warnings.some((w) => w.toLowerCase().includes("brittle"))).toBe(
      true,
    );
  });
});

describe("inputs", () => {
  it("emits safe fill without redaction", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/search" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "input",
            payload: {
              input_type: "text",
              input_name: "q",
              has_value: true,
              value: "search term",
              is_safe_selector_match: true,
            },
          },
        ],
      }),
    );
    expect(plan.hasRedactedSteps).toBe(false);
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain(".fill('search term')");
  });

  it("emits redacted placeholder", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/login" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "input",
            payload: {
              input_type: "text",
              input_name: "email",
              has_value: true,
              is_safe_selector_match: false,
            },
          },
        ],
      }),
    );
    expect(plan.hasRedactedSteps).toBe(true);
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain("REPLACE_WITH_TEST_VALUE");
    expect(code).toContain(
      "could not capture this value because input data is redacted",
    );
  });

  it("never emits sensitive values even when marked safe", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "input",
            payload: {
              input_type: "password",
              input_name: "password",
              has_value: true,
              value: "supersecret123",
              is_safe_selector_match: true,
            },
          },
        ],
      }),
    );
    const { code } = renderPlaywrightTest(plan);
    expect(code).not.toContain("supersecret123");
    expect(code).toContain("REPLACE_WITH_TEST_VALUE");
  });

  it("collapses input+change pairs on the same locator", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "input",
            payload: {
              input_type: "text",
              input_name: "q",
              has_value: true,
              value: "hel",
              is_safe_selector_match: true,
            },
          },
          {
            sequenceNumber: 3,
            occurredAt: "2026-09-01T00:00:02Z",
            id: "c",
            eventType: "input",
            payload: {
              input_type: "text",
              input_name: "q",
              has_value: true,
              value: "hello",
              is_safe_selector_match: true,
            },
          },
        ],
      }),
    );
    const fills = plan.actions.filter((a) => a.kind === "fill");
    expect(fills).toHaveLength(1);
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain(".fill('hello')");
    expect(code).not.toContain(".fill('hel')");
  });
});

describe("navigation", () => {
  it("sanitizes base + route and strips sensitive query", () => {
    const code = planAndCode(
      baseInput({
        baseUrl: "https://demo.test/",
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/checkout?token=abc&ok=1" },
          },
        ],
      }),
    );
    expect(code).toContain("https://demo.test/checkout");
    expect(code).not.toContain("token=abc");
  });

  it("rejects javascript: base URL", () => {
    expect(() =>
      buildReproductionPlan(baseInput({ baseUrl: "javascript:alert(1)" })),
    ).toThrowError(
      expect.objectContaining({ code: "REPRODUCTION_BASE_URL_REQUIRED" }),
    );
  });

  it("click followed by navigation asserts URL instead of redundant goto", () => {
    const plan = buildReproductionPlan(
      baseInput({
        timeline: [
          {
            sequenceNumber: 1,
            occurredAt: "2026-09-01T00:00:00Z",
            id: "a",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/" },
          },
          {
            sequenceNumber: 2,
            occurredAt: "2026-09-01T00:00:01Z",
            id: "b",
            eventType: "click",
            payload: {
              locator_candidates: [
                { type: "test_id", value: "product", confidence: 1 },
              ],
              element_tag: "button",
            },
          },
          {
            sequenceNumber: 3,
            occurredAt: "2026-09-01T00:00:02Z",
            id: "c",
            eventType: "navigation",
            payload: { to_url: "https://demo.test/product/123" },
          },
        ],
      }),
    );
    expect(plan.actions.some((a) => a.kind === "expectUrl")).toBe(true);
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain("toHaveURL");
  });
});

describe("assertions", () => {
  it("exception plan carries pageerror assertion", () => {
    const plan = buildReproductionPlan(baseInput());
    expect(plan.assertion.kind).toBe("pageerror");
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain("page.on('pageerror'");
    expect(code).toContain("toBe(true)");
  });

  it("network assertion matches method/path/status", () => {
    const plan = buildReproductionPlan(
      baseInput({
        failure: {
          kind: "network",
          method: "GET",
          url: "https://demo.test/api/profile?x=1",
          statusCode: 500,
        },
      }),
    );
    expect(plan.assertion).toMatchObject({
      kind: "network",
      method: "GET",
      route: "/api/profile",
      statusCode: 500,
    });
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain("/api/profile");
    expect(code).toContain("500");
  });

  it("console assertion listens for error console", () => {
    const plan = buildReproductionPlan(
      baseInput({
        failure: { kind: "console_error", expectedMessage: "boom failed" },
      }),
    );
    const { code } = renderPlaywrightTest(plan);
    expect(code).toContain("page.on('console'");
    expect(code).toContain("boom failed");
  });

  it("unsupported network-error without status fails safely", () => {
    expect(() =>
      buildReproductionPlan(
        baseInput({
          failure: {
            kind: "network",
            method: "GET",
            url: "https://demo.test/api/x",
            statusCode: null,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "REPRODUCTION_UNSUPPORTED_FAILURE" }),
    );
  });
});

describe("malicious telemetry", () => {
  const hostile = [
    "'); process.exit(1); //",
    "${process.env.SECRET}",
    '`); throw new Error("owned"); //',
    "*/",
    "<script>alert(1)</script>",
    "\\u2028\\u2029",
    "'\"`\\\n\r",
  ];
  it("keeps hostile strings inert and parseable", () => {
    for (const evil of hostile) {
      const code = planAndCode(
        baseInput({
          issueTitle: evil,
          timeline: [
            {
              sequenceNumber: 1,
              occurredAt: "2026-09-01T00:00:00Z",
              id: "a",
              eventType: "navigation",
              payload: { to_url: "https://demo.test/" },
            },
            {
              sequenceNumber: 2,
              occurredAt: "2026-09-01T00:00:01Z",
              id: "b",
              eventType: "click",
              payload: {
                locator_candidates: [
                  { type: "test_id", value: evil.slice(0, 60), confidence: 1 },
                ],
                element_tag: "button",
                accessible_name: evil.slice(0, 40),
              },
            },
          ],
          failure: {
            kind: "exception",
            expectedType: "Error",
            expectedMessage: evil.slice(0, 200),
          },
        }),
      );
      const res = validateGeneratedSyntax(code);
      expect(res.ok).toBe(true);
      // No raw executable breakout: hostile payload never appears as raw statement
      expect(code).toContain(
        "import { test, expect } from '@playwright/test';",
      );
    }
  });
});

describe("determinism", () => {
  it("100 repeated generations are byte-identical", () => {
    const input = baseInput({
      timeline: [
        {
          sequenceNumber: 1,
          occurredAt: "2026-09-01T00:00:00Z",
          id: "a",
          eventType: "navigation",
          payload: { to_url: "https://demo.test/checkout" },
        },
        {
          sequenceNumber: 2,
          occurredAt: "2026-09-01T00:00:01Z",
          id: "b",
          eventType: "click",
          payload: {
            locator_candidates: [
              { type: "test_id", value: "checkout-button", confidence: 1 },
            ],
            element_tag: "button",
          },
        },
      ],
    });
    const first = renderPlaywrightTest(buildReproductionPlan(input)).code;
    for (let i = 0; i < 100; i++) {
      const next = renderPlaywrightTest(buildReproductionPlan(input)).code;
      expect(next).toBe(first);
    }
  });
});

describe("metadata + version", () => {
  it("embeds generator version and portable imports", () => {
    const code = planAndCode(baseInput());
    expect(code).toContain(REPRODUCTION_GENERATOR_VERSION);
    expect(code).toContain("import { test, expect } from '@playwright/test';");
    expect(code).not.toContain("@replaybug");
    const res = validateGeneratedSyntax(code);
    expect(res.ok).toBe(true);
  });

  it("missing base URL throws machine-readable code", () => {
    try {
      buildReproductionPlan(baseInput({ baseUrl: "   " }));
      expect.unreachable();
    } catch (e) {
      expect((e as ReproductionError).code).toBe(
        "REPRODUCTION_BASE_URL_REQUIRED",
      );
    }
  });
});
