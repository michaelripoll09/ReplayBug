import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  aiAnalyses,
  events,
  issues,
  projects,
  projectKeys,
  projectOrigins,
  releases,
  reproductionTests,
  telemetrySessions,
  workspaces,
  type Database,
} from "@replaybug/db";

export const PUBLIC_DEMO_PROJECT_SLUG = "public-demo";
const MAX_LIST_ITEMS = 50;
const MAX_TEXT_LENGTH = 500;
const MAX_EVIDENCE_FRAMES = 10;

export interface PublicDemoProject {
  id: string;
  name: string;
  slug: string;
}

export interface PublicDemoConfig {
  enabled: true;
  projectId: string;
  environment: "production";
  release: "demo-1.0.0";
  origin: string;
  ingestUrl: string;
  publicKeyPrefix: string;
  publicKey?: string;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function text(value: string | null, maximum = MAX_TEXT_LENGTH): string | null {
  return value === null ? null : value.slice(0, maximum);
}

/** Resolves the marker before every public read; route IDs never select a tenant. */
export async function resolvePublicDemoProject(
  db: Database,
): Promise<PublicDemoProject | null> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug })
    .from(workspaces)
    .innerJoin(projects, eq(projects.workspaceId, workspaces.id))
    .where(
      and(
        eq(workspaces.isPublicDemo, true),
        eq(projects.slug, PUBLIC_DEMO_PROJECT_SLUG),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getPublicDemoConfig(
  db: Database,
  apiUrl: string,
  demoPublicKey?: string,
): Promise<PublicDemoConfig | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const origins = await db
    .select({ origin: projectOrigins.origin })
    .from(projectOrigins)
    .where(
      and(
        eq(projectOrigins.projectId, project.id),
        eq(projectOrigins.isEnabled, true),
      ),
    )
    .orderBy(asc(projectOrigins.origin))
    .limit(1);
  const keys = await db
    .select({ prefix: projectKeys.prefix })
    .from(projectKeys)
    .where(
      and(
        eq(projectKeys.projectId, project.id),
        eq(projectKeys.kind, "public_ingest"),
      ),
    )
    .orderBy(asc(projectKeys.createdAt))
    .limit(1);
  const origin = origins[0]?.origin;
  const publicKeyPrefix = keys[0]?.prefix;
  if (origin === undefined || publicKeyPrefix === undefined) return null;
  return {
    enabled: true,
    projectId: project.id,
    environment: "production",
    release: "demo-1.0.0",
    origin,
    ingestUrl: `${apiUrl.replace(/\/$/, "")}/api/ingest/v1/batch`,
    // A prefix is public metadata, unlike a key hash or credential.
    publicKeyPrefix,
    // This is the intentionally public ingest key configured for the demo;
    // hashes and secret tokens are never loaded or returned here.
    ...(demoPublicKey === undefined ? {} : { publicKey: demoPublicKey }),
  };
}

export async function getPublicDemoOverview(
  db: Database,
): Promise<unknown | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const [issueCount, sessionCount, releaseCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(eq(issues.projectId, project.id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(telemetrySessions)
      .where(eq(telemetrySessions.projectId, project.id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(releases)
      .where(eq(releases.projectId, project.id)),
  ]);
  return {
    project,
    issueCount: issueCount[0]?.count ?? 0,
    sessionCount: sessionCount[0]?.count ?? 0,
    releaseCount: releaseCount[0]?.count ?? 0,
  };
}

function issueDto(row: typeof issues.$inferSelect) {
  return {
    id: row.id,
    title: row.title.slice(0, MAX_TEXT_LENGTH),
    normalizedMessage: row.normalizedMessage.slice(0, MAX_TEXT_LENGTH),
    type: row.type,
    status: row.status,
    severity: row.severity,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    occurrenceCount: row.occurrenceCount,
    affectedSessionCount: row.affectedSessionCount,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function evidenceText(
  value: unknown,
  maximum = MAX_TEXT_LENGTH,
): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function evidenceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function rawEvidenceFrame(value: unknown) {
  const frame = record(value);
  return {
    filename: evidenceText(frame["filename"]),
    function: evidenceText(frame["function"]),
    lineno: evidenceNumber(frame["lineno"]),
    colno: evidenceNumber(frame["colno"]),
    inApp: typeof frame["inApp"] === "boolean" ? frame["inApp"] : null,
  };
}

function mappedEvidenceFrame(value: unknown) {
  const frame = record(value);
  return {
    filename: evidenceText(frame["filename"]),
    source: evidenceText(frame["source"]),
    function: evidenceText(frame["function"]),
    name: evidenceText(frame["name"]),
    line: evidenceNumber(frame["line"]),
    column: evidenceNumber(frame["column"]),
    inApplication:
      typeof frame["inApplication"] === "boolean"
        ? frame["inApplication"]
        : null,
    mapped: typeof frame["mapped"] === "boolean" ? frame["mapped"] : null,
  };
}

function issueEvidenceDto(row: typeof events.$inferSelect) {
  const payload = record(row.payloadJson);
  const value = record(
    Array.isArray(payload["values"]) ? payload["values"][0] : null,
  );
  const symbolication = record(row.symbolicationJson);
  const rawFrames = Array.isArray(symbolication["rawFrames"])
    ? symbolication["rawFrames"]
    : [];
  const mappedFrames = Array.isArray(symbolication["mappedFrames"])
    ? symbolication["mappedFrames"]
    : [];

  return {
    message: evidenceText(value["value"]),
    type: evidenceText(value["type"], 256),
    rawFrames: rawFrames.slice(0, MAX_EVIDENCE_FRAMES).map(rawEvidenceFrame),
    mappedFrames: mappedFrames
      .slice(0, MAX_EVIDENCE_FRAMES)
      .map(mappedEvidenceFrame),
  };
}

export async function listPublicDemoIssues(
  db: Database,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(issues)
    .where(eq(issues.projectId, project.id))
    .orderBy(desc(issues.lastSeenAt), asc(issues.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map(issueDto);
}

export async function getPublicDemoIssue(
  db: Database,
  issueId: string,
): Promise<unknown | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, project.id)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  const evidenceRows = await db
    .select()
    .from(events)
    .where(and(eq(events.issueId, row.id), eq(events.projectId, project.id)))
    .orderBy(
      desc(sql`case
        when jsonb_typeof(${events.payloadJson}->'values') = 'array'
          and jsonb_array_length(${events.payloadJson}->'values') > 0
        then 1
        else 0
      end`),
      asc(events.occurredAt),
      asc(events.id),
    )
    .limit(1);
  const evidence = evidenceRows[0];
  return {
    ...issueDto(row),
    evidence:
      evidence === undefined
        ? { message: null, type: null, rawFrames: [], mappedFrames: [] }
        : issueEvidenceDto(evidence),
  };
}

function occurrenceDto(row: typeof events.$inferSelect) {
  return {
    id: row.id,
    sessionId: row.telemetrySessionId,
    issueId: row.issueId,
    eventType: row.eventType,
    occurredAt: iso(row.occurredAt),
    environment: row.environment,
    release: text(row.release, 128),
    pageUrl: text(row.pageUrl),
    processingState: row.processingState,
  };
}

export async function listPublicDemoOccurrences(
  db: Database,
  issueId: string,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(events)
    .innerJoin(issues, eq(events.issueId, issues.id))
    .where(and(eq(events.issueId, issueId), eq(issues.projectId, project.id)))
    .orderBy(desc(events.occurredAt), asc(events.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map((row) => occurrenceDto(row.events));
}

function sessionDto(row: typeof telemetrySessions.$inferSelect) {
  return {
    id: row.id,
    environment: row.environment,
    release: text(row.release, 128),
    initialUrl: row.initialUrl.slice(0, MAX_TEXT_LENGTH),
    browserName: text(row.browserName, 100),
    osName: text(row.osName, 100),
    deviceType: text(row.deviceType, 100),
    startedAt: iso(row.startedAt),
    lastSeenAt: iso(row.lastSeenAt),
  };
}

export async function listPublicDemoSessions(
  db: Database,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(eq(telemetrySessions.projectId, project.id))
    .orderBy(desc(telemetrySessions.lastSeenAt), asc(telemetrySessions.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map(sessionDto);
}

export async function getPublicDemoSession(
  db: Database,
  sessionId: string,
): Promise<unknown | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(telemetrySessions)
    .where(
      and(
        eq(telemetrySessions.id, sessionId),
        eq(telemetrySessions.projectId, project.id),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (session === undefined) return null;
  const timeline = await db
    .select()
    .from(events)
    .where(eq(events.telemetrySessionId, session.id))
    .orderBy(asc(events.sequenceNumber), asc(events.id))
    .limit(MAX_LIST_ITEMS);
  return { ...sessionDto(session), timeline: timeline.map(occurrenceDto) };
}

export async function listPublicDemoReleases(
  db: Database,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select()
    .from(releases)
    .where(eq(releases.projectId, project.id))
    .orderBy(desc(releases.createdAt), asc(releases.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    commitSha: text(row.commitSha, 64),
    createdAt: iso(row.createdAt),
  }));
}

export async function listPublicDemoReproductions(
  db: Database,
  issueId: string,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select({ reproduction: reproductionTests })
    .from(reproductionTests)
    .innerJoin(issues, eq(reproductionTests.issueId, issues.id))
    .where(
      and(
        eq(reproductionTests.issueId, issueId),
        eq(issues.projectId, project.id),
      ),
    )
    .orderBy(desc(reproductionTests.createdAt), asc(reproductionTests.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map(({ reproduction }) => ({
    id: reproduction.id,
    eventId: reproduction.eventId,
    status: reproduction.status,
    language: reproduction.language,
    framework: reproduction.framework,
    hasRedactedSteps: reproduction.hasRedactedSteps,
    createdAt: iso(reproduction.createdAt),
    completedAt:
      reproduction.completedAt === null ? null : iso(reproduction.completedAt),
  }));
}

export async function listPublicDemoAi(
  db: Database,
  issueId: string,
): Promise<unknown[] | null> {
  const project = await resolvePublicDemoProject(db);
  if (project === null) return null;
  const rows = await db
    .select({ analysis: aiAnalyses })
    .from(aiAnalyses)
    .innerJoin(issues, eq(aiAnalyses.issueId, issues.id))
    .where(
      and(eq(aiAnalyses.issueId, issueId), eq(issues.projectId, project.id)),
    )
    .orderBy(desc(aiAnalyses.createdAt), asc(aiAnalyses.id))
    .limit(MAX_LIST_ITEMS);
  return rows.map(({ analysis }) => ({
    id: analysis.id,
    eventId: analysis.eventId,
    model: analysis.model.slice(0, 128),
    status: analysis.status,
    summary: text(analysis.summary),
    suspectedCause: text(analysis.suspectedCause),
    evidence: (analysis.evidenceJson ?? []).slice(0, 10).map((item) => ({
      ref: item.ref.slice(0, 128),
      reason: item.reason.slice(0, MAX_TEXT_LENGTH),
    })),
    reproductionSteps: (analysis.reproductionStepsJson ?? [])
      .slice(0, 10)
      .map((item) => item.slice(0, MAX_TEXT_LENGTH)),
    limitations: (analysis.limitationsJson ?? [])
      .slice(0, 10)
      .map((item) => item.slice(0, MAX_TEXT_LENGTH)),
    completedAt:
      analysis.completedAt === null ? null : iso(analysis.completedAt),
  }));
}
