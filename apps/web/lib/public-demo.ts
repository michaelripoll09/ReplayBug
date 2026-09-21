export interface PublicDemoOverview {
  project: {
    id: string;
    name: string;
    slug: string;
  };
  issueCount: number;
  sessionCount: number;
  releaseCount: number;
}

export interface PublicDemoMappedFrame {
  filename: string | null;
  source: string | null;
  function: string | null;
  name: string | null;
  line: number | null;
  column: number | null;
  inApplication: boolean | null;
  mapped: boolean | null;
}

export interface PublicDemoRawFrame {
  filename: string | null;
  function: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean | null;
}

export interface PublicDemoEvidence {
  message: string | null;
  type: string | null;
  mappedFrames: PublicDemoMappedFrame[];
  rawFrames: PublicDemoRawFrame[];
}

export interface PublicDemoIssue {
  id: string;
  title: string;
  normalizedMessage: string;
  type: string;
  status: string;
  severity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  affectedSessionCount: number;
  evidence?: PublicDemoEvidence;
}

export interface PublicDemoOccurrence {
  id: string;
  sessionId: string;
  issueId: string;
  eventType: string;
  occurredAt: string;
  environment: string;
  release: string | null;
  pageUrl: string | null;
  processingState: string;
}

export interface PublicDemoReproduction {
  id: string;
  eventId: string;
  status: string;
  language: string;
  framework: string;
  hasRedactedSteps: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface PublicDemoAiAnalysis {
  id: string;
  eventId: string | null;
  model: string;
  status: string;
  summary: string | null;
  suspectedCause: string | null;
  evidence: Array<{ ref: string; reason: string }>;
  reproductionSteps: string[];
  limitations: string[];
  completedAt: string | null;
}

export interface PublicDemoSession {
  id: string;
  environment: string;
  release: string | null;
  initialUrl: string;
  browserName: string | null;
  osName: string | null;
  deviceType: string | null;
  startedAt: string;
  lastSeenAt: string;
  timeline: PublicDemoOccurrence[];
}

export class PublicDemoRequestError extends Error {
  constructor(
    public readonly status: number,
    message = "The public demo is unavailable.",
  ) {
    super(message);
    this.name = "PublicDemoRequestError";
  }
}

const DEFAULT_API_URL = "http://localhost:4001";
const MAX_EVIDENCE_FRAMES = 10;
const MAX_EVIDENCE_TEXT_LENGTH = 500;
const MAX_EVIDENCE_TYPE_LENGTH = 256;

function apiBaseUrl(): string {
  return (
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"] ?? DEFAULT_API_URL
  ).replace(/\/+$/, "");
}

function endpoint(path: string): string {
  return `${apiBaseUrl()}/api/v1/public-demo${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function boundedNullableString(
  record: Record<string, unknown>,
  key: string,
  maximum = MAX_EVIDENCE_TEXT_LENGTH,
): string | null {
  const value = nullableString(record, key);
  if (value !== null && value.length > maximum) {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function nullableNonnegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function nullableBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new PublicDemoRequestError(500);
  }
  return value;
}

function arrayOf<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new PublicDemoRequestError(500);
  }
  return value.map(parse);
}

function boundedArrayOf<T>(
  value: unknown,
  maximum: number,
  parse: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PublicDemoRequestError(500);
  }
  return value.map(parse);
}

function parseEvidence(value: unknown): PublicDemoEvidence | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  return {
    message: boundedNullableString(value, "message"),
    type: boundedNullableString(value, "type", MAX_EVIDENCE_TYPE_LENGTH),
    mappedFrames: boundedArrayOf(
      value["mappedFrames"],
      MAX_EVIDENCE_FRAMES,
      (frame) => {
        if (!isRecord(frame)) {
          throw new PublicDemoRequestError(500);
        }
        return {
          filename: boundedNullableString(frame, "filename"),
          source: boundedNullableString(frame, "source"),
          function: boundedNullableString(frame, "function"),
          name: boundedNullableString(frame, "name"),
          line: nullableNonnegativeInteger(frame, "line"),
          column: nullableNonnegativeInteger(frame, "column"),
          inApplication: nullableBoolean(frame, "inApplication"),
          mapped: nullableBoolean(frame, "mapped"),
        };
      },
    ),
    rawFrames: boundedArrayOf(
      value["rawFrames"],
      MAX_EVIDENCE_FRAMES,
      (frame) => {
        if (!isRecord(frame)) {
          throw new PublicDemoRequestError(500);
        }
        return {
          filename: boundedNullableString(frame, "filename"),
          function: boundedNullableString(frame, "function"),
          lineno: nullableNonnegativeInteger(frame, "lineno"),
          colno: nullableNonnegativeInteger(frame, "colno"),
          inApp: nullableBoolean(frame, "inApp"),
        };
      },
    ),
  };
}

function parseIssue(value: unknown): PublicDemoIssue {
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  const evidence = parseEvidence(value["evidence"]);
  return {
    id: requiredString(value, "id"),
    title: requiredString(value, "title"),
    normalizedMessage: requiredString(value, "normalizedMessage"),
    type: requiredString(value, "type"),
    status: requiredString(value, "status"),
    severity: requiredString(value, "severity"),
    firstSeenAt: requiredString(value, "firstSeenAt"),
    lastSeenAt: requiredString(value, "lastSeenAt"),
    occurrenceCount: requiredNumber(value, "occurrenceCount"),
    affectedSessionCount: requiredNumber(value, "affectedSessionCount"),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function parseOccurrence(value: unknown): PublicDemoOccurrence {
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  return {
    id: requiredString(value, "id"),
    sessionId: requiredString(value, "sessionId"),
    issueId: requiredString(value, "issueId"),
    eventType: requiredString(value, "eventType"),
    occurredAt: requiredString(value, "occurredAt"),
    environment: requiredString(value, "environment"),
    release: nullableString(value, "release"),
    pageUrl: nullableString(value, "pageUrl"),
    processingState: requiredString(value, "processingState"),
  };
}

function parseReproduction(value: unknown): PublicDemoReproduction {
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  return {
    id: requiredString(value, "id"),
    eventId: requiredString(value, "eventId"),
    status: requiredString(value, "status"),
    language: requiredString(value, "language"),
    framework: requiredString(value, "framework"),
    hasRedactedSteps: requiredBoolean(value, "hasRedactedSteps"),
    createdAt: requiredString(value, "createdAt"),
    completedAt: nullableString(value, "completedAt"),
  };
}

function parseAiAnalysis(value: unknown): PublicDemoAiAnalysis {
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  return {
    id: requiredString(value, "id"),
    eventId: nullableString(value, "eventId"),
    model: requiredString(value, "model"),
    status: requiredString(value, "status"),
    summary: nullableString(value, "summary"),
    suspectedCause: nullableString(value, "suspectedCause"),
    evidence: arrayOf(value["evidence"], (item) => {
      if (!isRecord(item)) {
        throw new PublicDemoRequestError(500);
      }
      return {
        ref: requiredString(item, "ref"),
        reason: requiredString(item, "reason"),
      };
    }),
    reproductionSteps: arrayOf(value["reproductionSteps"], (item) => {
      if (typeof item !== "string") {
        throw new PublicDemoRequestError(500);
      }
      return item;
    }),
    limitations: arrayOf(value["limitations"], (item) => {
      if (typeof item !== "string") {
        throw new PublicDemoRequestError(500);
      }
      return item;
    }),
    completedAt: nullableString(value, "completedAt"),
  };
}

function parseSession(value: unknown): PublicDemoSession {
  if (!isRecord(value)) {
    throw new PublicDemoRequestError(500);
  }
  return {
    id: requiredString(value, "id"),
    environment: requiredString(value, "environment"),
    release: nullableString(value, "release"),
    initialUrl: requiredString(value, "initialUrl"),
    browserName: nullableString(value, "browserName"),
    osName: nullableString(value, "osName"),
    deviceType: nullableString(value, "deviceType"),
    startedAt: requiredString(value, "startedAt"),
    lastSeenAt: requiredString(value, "lastSeenAt"),
    timeline: arrayOf(value["timeline"], parseOccurrence),
  };
}

async function getPublicDemo<T>(
  path: string,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(endpoint(path), {
    credentials: "omit",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new PublicDemoRequestError(response.status);
  }
  return parse((await response.json()) as unknown);
}

export function getPublicDemoOverview(
  signal?: AbortSignal,
): Promise<PublicDemoOverview> {
  return getPublicDemo(
    "/overview",
    (value) => {
      if (!isRecord(value) || !isRecord(value["project"])) {
        throw new PublicDemoRequestError(500);
      }
      const project = value["project"];
      return {
        project: {
          id: requiredString(project, "id"),
          name: requiredString(project, "name"),
          slug: requiredString(project, "slug"),
        },
        issueCount: requiredNumber(value, "issueCount"),
        sessionCount: requiredNumber(value, "sessionCount"),
        releaseCount: requiredNumber(value, "releaseCount"),
      };
    },
    signal,
  );
}

export function listPublicDemoIssues(
  signal?: AbortSignal,
): Promise<PublicDemoIssue[]> {
  return getPublicDemo(
    "/issues",
    (value) => arrayOf(value, parseIssue),
    signal,
  );
}

export function getPublicDemoIssue(
  issueId: string,
  signal?: AbortSignal,
): Promise<PublicDemoIssue> {
  return getPublicDemo(
    `/issues/${encodeURIComponent(issueId)}`,
    parseIssue,
    signal,
  );
}

export function listPublicDemoOccurrences(
  issueId: string,
  signal?: AbortSignal,
): Promise<PublicDemoOccurrence[]> {
  return getPublicDemo(
    `/issues/${encodeURIComponent(issueId)}/occurrences`,
    (value) => arrayOf(value, parseOccurrence),
    signal,
  );
}

export function listPublicDemoReproductions(
  issueId: string,
  signal?: AbortSignal,
): Promise<PublicDemoReproduction[]> {
  return getPublicDemo(
    `/issues/${encodeURIComponent(issueId)}/reproductions`,
    (value) => arrayOf(value, parseReproduction),
    signal,
  );
}

export function listPublicDemoAi(
  issueId: string,
  signal?: AbortSignal,
): Promise<PublicDemoAiAnalysis[]> {
  return getPublicDemo(
    `/issues/${encodeURIComponent(issueId)}/ai`,
    (value) => arrayOf(value, parseAiAnalysis),
    signal,
  );
}

export function getPublicDemoSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PublicDemoSession> {
  return getPublicDemo(
    `/sessions/${encodeURIComponent(sessionId)}`,
    parseSession,
    signal,
  );
}
