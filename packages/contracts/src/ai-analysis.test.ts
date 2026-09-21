import { describe, expect, it } from "vitest";
import {
  AI_ANALYSIS_VERSION,
  aiAnalysisDetailSchema,
  aiAnalysisJobPayloadSchema,
  aiAnalysisOutputSchema,
  aiAnalysisStatusSchema,
  aiAnalysisSummarySchema,
} from "./ai-analysis.js";

const ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ISO = "2026-09-18T12:00:00.000Z";

const output = {
  summary: "The checkout exception occurs after a stale session transition.",
  suspectedCause: "A client-side state update races with session renewal.",
  evidence: [
    { ref: "stack:1", reason: "The top frame calls the renewal path." },
  ],
  reproductionSteps: [
    "Open checkout",
    "Allow the session to expire",
    "Submit payment",
  ],
  limitations: ["The retained timeline does not include server traces."],
};

describe("AI analysis contracts", () => {
  it("exposes the stable analysis and job versions", () => {
    expect(AI_ANALYSIS_VERSION).toBe("1.0.0");
    expect(aiAnalysisStatusSchema.options).toEqual([
      "pending",
      "ready",
      "failed",
    ]);
    expect(
      aiAnalysisJobPayloadSchema.parse({ version: 1, analysisId: ID }),
    ).toEqual({ version: 1, analysisId: ID });
  });

  it("accepts only the exact bounded structured output", () => {
    expect(aiAnalysisOutputSchema.parse(output)).toEqual(output);
    expect(() =>
      aiAnalysisOutputSchema.parse({ ...output, providerTrace: "secret" }),
    ).toThrow();
    expect(() =>
      aiAnalysisOutputSchema.parse({
        ...output,
        evidence: [{ ...output.evidence[0], rawPayload: "secret" }],
      }),
    ).toThrow();
    expect(() =>
      aiAnalysisOutputSchema.parse({
        ...output,
        summary: "x".repeat(4_001),
      }),
    ).toThrow();
    expect(() =>
      aiAnalysisOutputSchema.parse({
        ...output,
        reproductionSteps: Array.from({ length: 11 }, () => "step"),
      }),
    ).toThrow();
  });

  it("keeps history and detail DTOs strict and status-aware", () => {
    const summary = aiAnalysisSummarySchema.parse({
      id: ID,
      issueId: ID,
      eventId: EVENT_ID,
      model: "qwen2.5:7b",
      status: "ready",
      requestedByUserId: "user-1",
      analysisVersion: AI_ANALYSIS_VERSION,
      createdAt: ISO,
      completedAt: ISO,
    });
    expect(summary.status).toBe("ready");

    const detail = aiAnalysisDetailSchema.parse({
      ...summary,
      result: output,
      errorCode: null,
      errorMessage: null,
    });
    expect(detail.result?.evidence[0]?.ref).toBe("stack:1");
    expect(() =>
      aiAnalysisDetailSchema.parse({ ...detail, extra: true }),
    ).toThrow();
    expect(() =>
      aiAnalysisDetailSchema.parse({
        ...detail,
        status: "failed",
        result: output,
      }),
    ).toThrow();
  });
});
