const MAX_MESSAGE_CHARS = 2_048;
const MAX_TEXT_CHARS = 1_024;
const MAX_STACK_FRAMES = 10;
const MAX_TIMELINE_EVENTS = 30;
const MAX_NETWORK_EVENTS = 10;
export const MAX_EVIDENCE_BYTES = 65_536;

export interface AiEvidenceIssueInput {
  normalizedMessage: string;
  type: string;
  severity: string;
  exceptionType?: string | null;
}
export interface AiEvidenceSelectedEventInput {
  id: string;
  sessionId: string;
  occurredAt: string;
  receivedAt?: string | null;
  environment: string;
  release?: string | null;
}
export interface AiEvidenceMappedFrameInput {
  source: string;
  name: string | null;
  line: number;
  column: number;
}
export interface AiEvidenceRawFrameInput {
  filename: string;
  function: string | null;
  line: number;
  column: number;
}
export interface AiEvidenceTimelineInput {
  id: string;
  sessionId: string;
  occurredAt: string;
  kind: string;
  message: string;
}
export interface AiEvidenceNetworkInput {
  id: string;
  sessionId: string;
  occurredAt: string;
  method: string;
  path: string;
  status: number;
}
/** Explicit allowlisted records only; callers cannot pass database rows or payload bags. */
export interface AiEvidenceInput {
  issue: AiEvidenceIssueInput;
  selectedEvent: AiEvidenceSelectedEventInput;
  mappedStack: readonly AiEvidenceMappedFrameInput[];
  rawStack: readonly AiEvidenceRawFrameInput[];
  timeline: readonly AiEvidenceTimelineInput[];
  network: readonly AiEvidenceNetworkInput[];
}

interface EvidenceStackFrame {
  ref: string;
  source: string;
  name: string | null;
  line: number;
  column: number;
}
interface EvidenceTimelineEvent {
  ref: string;
  occurredAt: string;
  kind: string;
  message: string;
}
interface EvidenceNetworkEvent {
  ref: string;
  occurredAt: string;
  method: string;
  path: string;
  status: number;
}
export interface AiEvidenceBundle {
  issue: {
    message: { ref: "issue:message"; text: string };
    type: string;
    severity: string;
    exceptionType: string | null;
  };
  stack: EvidenceStackFrame[];
  timeline: EvidenceTimelineEvent[];
  network: EvidenceNetworkEvent[];
  environment: string;
  release: { ref: "release:current"; value: string } | null;
  timestamps: { occurredAt: string; receivedAt: string | null };
}
export interface BuiltAiEvidence {
  bundle: AiEvidenceBundle;
  serialized: string;
  allowedRefs: string[];
}

export class AiEvidenceError extends Error {
  readonly code = "EVIDENCE_BUNDLE_TOO_LARGE" as const;
  constructor() {
    super("Sanitized AI evidence exceeds the supported size limit.");
    this.name = "AiEvidenceError";
  }
}

function removeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
}

function boundedText(
  value: string | null | undefined,
  max = MAX_TEXT_CHARS,
): string {
  const normalized = removeControlCharacters(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(
      /\b(?:password|token|cookie|authorization)\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted]");
  return normalized.slice(0, max);
}

function boundedInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safePath(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
  const path = boundedText(withoutQuery, MAX_TEXT_CHARS);
  return path.startsWith("/") ? path : `/${path}`;
}

function comparableTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function allowedRefs(bundle: AiEvidenceBundle): string[] {
  const refs = [
    "issue:message",
    ...bundle.stack.map((entry) => entry.ref),
    ...bundle.timeline.map((entry) => entry.ref),
    ...bundle.network.map((entry) => entry.ref),
  ];
  if (bundle.release !== null) refs.push("release:current");
  return refs;
}

function serializeWithinLimit(bundle: AiEvidenceBundle): string {
  let serialized = JSON.stringify(bundle);
  while (Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) {
    if (bundle.network.length > 0) bundle.network.pop();
    else if (bundle.timeline.length > 0) bundle.timeline.pop();
    else if (bundle.stack.length > 0) bundle.stack.pop();
    else throw new AiEvidenceError();
    serialized = JSON.stringify(bundle);
  }
  return serialized;
}

export function buildAiEvidence(input: AiEvidenceInput): BuiltAiEvidence {
  const selectedTime = comparableTime(input.selectedEvent.occurredAt);
  const useMapped = input.mappedStack.length > 0;
  const stack = (useMapped ? input.mappedStack : input.rawStack)
    .slice(0, MAX_STACK_FRAMES)
    .map((frame, index): EvidenceStackFrame =>
      useMapped
        ? {
            ref: `stack:${index + 1}`,
            source: boundedText(
              (frame as AiEvidenceMappedFrameInput).source,
              512,
            ),
            name:
              boundedText((frame as AiEvidenceMappedFrameInput).name, 512) ||
              null,
            line: boundedInteger((frame as AiEvidenceMappedFrameInput).line),
            column: boundedInteger(
              (frame as AiEvidenceMappedFrameInput).column,
            ),
          }
        : {
            ref: `stack:${index + 1}`,
            source: boundedText(
              (frame as AiEvidenceRawFrameInput).filename,
              512,
            ),
            name:
              boundedText((frame as AiEvidenceRawFrameInput).function, 512) ||
              null,
            line: boundedInteger((frame as AiEvidenceRawFrameInput).line),
            column: boundedInteger((frame as AiEvidenceRawFrameInput).column),
          },
    );
  const timeline = input.timeline
    .filter(
      (event) =>
        event.sessionId === input.selectedEvent.sessionId &&
        comparableTime(event.occurredAt) <= selectedTime &&
        boundedText(event.message) !== "",
    )
    .sort(
      (left, right) =>
        comparableTime(right.occurredAt) - comparableTime(left.occurredAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_TIMELINE_EVENTS)
    .map((event): EvidenceTimelineEvent => ({
      ref: `timeline:${boundedText(event.id, 128)}`,
      occurredAt: boundedText(event.occurredAt, 64),
      kind: boundedText(event.kind, 128),
      message: boundedText(event.message),
    }));
  const network = input.network
    .filter(
      (event) =>
        event.sessionId === input.selectedEvent.sessionId &&
        comparableTime(event.occurredAt) <= selectedTime &&
        Number.isInteger(event.status) &&
        event.status >= 400,
    )
    .sort(
      (left, right) =>
        comparableTime(right.occurredAt) - comparableTime(left.occurredAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, MAX_NETWORK_EVENTS)
    .map((event): EvidenceNetworkEvent => ({
      ref: `network:${boundedText(event.id, 128)}`,
      occurredAt: boundedText(event.occurredAt, 64),
      method: boundedText(event.method, 16).toUpperCase(),
      path: safePath(event.path),
      status: event.status,
    }));
  const release = boundedText(input.selectedEvent.release, 256);
  const bundle: AiEvidenceBundle = {
    issue: {
      message: {
        ref: "issue:message",
        text: boundedText(input.issue.normalizedMessage, MAX_MESSAGE_CHARS),
      },
      type: boundedText(input.issue.type, 128),
      severity: boundedText(input.issue.severity, 128),
      exceptionType: boundedText(input.issue.exceptionType, 256) || null,
    },
    stack,
    timeline,
    network,
    environment: boundedText(input.selectedEvent.environment, 128),
    release: release === "" ? null : { ref: "release:current", value: release },
    timestamps: {
      occurredAt: boundedText(input.selectedEvent.occurredAt, 64),
      receivedAt:
        input.selectedEvent.receivedAt === null ||
        input.selectedEvent.receivedAt === undefined
          ? null
          : boundedText(input.selectedEvent.receivedAt, 64),
    },
  };
  const serialized = serializeWithinLimit(bundle);
  return { bundle, serialized, allowedRefs: allowedRefs(bundle) };
}
