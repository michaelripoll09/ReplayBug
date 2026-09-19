/**
 * Generator-owned input + intermediate representation types.
 * Deliberately independent of @replaybug/contracts to keep the pure
 * boundary clean; the worker adapts DB/contracts shapes into these.
 */

export type ReproducibleFailureKind =
  "exception" | "unhandled_rejection" | "network" | "console_error";

export interface GenerationLocatorCandidate {
  type: string;
  value: string;
  confidence: number;
}

export interface TimelineEvidenceItem {
  /** Stable ordering key from the session. */
  sequenceNumber: number;
  occurredAt: string;
  id: string;
  eventType: string;
  pageUrl?: string;
  payload: Record<string, unknown>;
  /** Embedded breadcrumb ring for dedup (optional). */
  breadcrumbs?: Array<Record<string, unknown>>;
}

export interface FailureEvidence {
  kind: ReproducibleFailureKind;
  /** Normalized expected message/type for assertions. */
  expectedType?: string;
  expectedMessage?: string;
  /** Network specifics. */
  method?: string;
  url?: string;
  statusCode?: number | null;
  failureCategory?: string;
}

export interface GenerationInput {
  issueId: string;
  issueTitle: string;
  issueType: string;
  occurrenceEventId: string;
  environment: string;
  release?: string;
  baseUrl: string;
  /** Session events with sequence <= occurrence, chronologically ordered. */
  timeline: TimelineEvidenceItem[];
  failure: FailureEvidence;
}

export type ReproductionAction =
  | { kind: "navigate"; route: string; note?: string }
  | {
      kind: "click";
      locatorExpression: string;
      strategy: string;
      brittle: boolean;
      label?: string;
    }
  | {
      kind: "fill";
      locatorExpression: string;
      strategy: string;
      value?: string;
      redacted: boolean;
      inputName?: string;
    }
  | { kind: "expectUrl"; route: string };

export type ReproductionAssertion =
  | { kind: "pageerror"; expectedType?: string; expectedMessage?: string }
  | {
      kind: "network";
      method: string;
      route: string;
      statusCode?: number | null;
      failureCategory?: string;
    }
  | { kind: "console_error"; expectedMessage?: string };

export interface ReproductionPlan {
  generatorVersion: string;
  issueId: string;
  issueTitle: string;
  occurrenceEventId: string;
  environment: string;
  release?: string;
  baseUrl: string;
  startRoute: string;
  actions: ReproductionAction[];
  diagnostics: string[];
  assertion: ReproductionAssertion;
  warnings: string[];
  hasRedactedSteps: boolean;
}

export interface GeneratedReproduction {
  code: string;
  hasRedactedSteps: boolean;
  warnings: string[];
}
