import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";
const NEWEST_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const OLDEST_EVENT_ID = "22222222-2222-4222-8222-222222222222";

interface AuthSession {
  cookies: string[];
  userId: string;
}

interface ProjectFixture {
  ownerCookie: string;
  ownerId: string;
  viewerCookie: string;
  projectId: string;
  issueId: string;
}

interface EventOptions {
  id?: string;
  issueId: string | null;
  sequenceNumber: number;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  symbolication?: Record<string, unknown> | null;
}

interface ReproductionOptions {
  eventId: string | null;
  status: "pending" | "ready" | "failed";
  errorCode: string | null;
  code: string | null;
  completedAt: string | null;
  createdAt: string;
}

async function signup(
  app: AppInstance,
  email: string,
  name: string,
): Promise<AuthSession> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name },
  });
  if (response.statusCode !== 200 && response.statusCode !== 201) {
    throw new Error(`signup failed ${response.statusCode}: ${response.body}`);
  }
  const rawCookies = response.headers["set-cookie"];
  const cookies = Array.isArray(rawCookies)
    ? rawCookies.map(String)
    : rawCookies === undefined
      ? []
      : [String(rawCookies)];
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: cookiesHeader(cookies) },
  });
  return {
    cookies,
    userId: (me.json() as { id: string }).id,
  };
}

async function createWorkspaceAndProject(
  app: AppInstance,
  cookie: string,
  label: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { cookie },
    payload: { name: `${label} workspace` },
  });
  if (workspace.statusCode !== 201) {
    throw new Error(
      `workspace failed ${workspace.statusCode}: ${workspace.body}`,
    );
  }
  const workspaceId = (workspace.json() as { id: string }).id;
  const project = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/projects`,
    headers: { cookie },
    payload: { name: `${label} project` },
  });
  if (project.statusCode !== 201) {
    throw new Error(`project failed ${project.statusCode}: ${project.body}`);
  }
  return {
    workspaceId,
    projectId: (project.json() as { project: { id: string } }).project.id,
  };
}

function fingerprint(): string {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
}

async function insertIssue(
  dbClient: DbClient,
  projectId: string,
  values: {
    title: string;
    normalizedMessage: string;
    occurrenceCount?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await dbClient.pool.query(
    `INSERT INTO issues
       ("id", "project_id", "fingerprint", "fingerprint_signature", "type",
        "title", "normalized_message", "status", "severity", "first_seen_at",
        "last_seen_at", "first_release", "last_release", "occurrence_count",
        "affected_session_count")
     VALUES ($1, $2, $3, 'private-signature', 'exception', $4, $5,
             'investigating', 'error', $6, $7, 'web@1.0.0', 'web@1.0.1', $8, 1)`,
    [
      id,
      projectId,
      fingerprint(),
      values.title,
      values.normalizedMessage,
      "2026-09-18T09:00:00.000Z",
      "2026-09-18T12:00:00.000Z",
      values.occurrenceCount ?? 2,
    ],
  );
  return id;
}

async function insertSession(
  dbClient: DbClient,
  projectId: string,
): Promise<string> {
  const id = randomUUID();
  await dbClient.pool.query(
    `INSERT INTO telemetry_sessions
       ("id", "project_id", "sdk_session_id", "environment", "release",
        "initial_url", "sdk_version")
     VALUES ($1, $2, $3, 'production', 'web@1.0.0',
             'https://example.com/start', 'sdk@1.0.0')`,
    [id, projectId, `sdk-${id}`],
  );
  return id;
}

async function insertEvent(
  dbClient: DbClient,
  projectId: string,
  sessionId: string,
  options: EventOptions,
): Promise<string> {
  const id = options.id ?? randomUUID();
  await dbClient.pool.query(
    `INSERT INTO events
       ("id", "project_id", "telemetry_session_id", "client_event_id",
        "sequence_number", "event_type", "occurred_at", "received_at",
        "environment", "release", "page_url", "payload_json", "issue_id",
        "symbolication_json", "processing_state")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'production', 'web@1.0.0',
             'https://example.com/app', $8, $9, $10, 'processed')`,
    [
      id,
      projectId,
      sessionId,
      `client-${id}`,
      options.sequenceNumber,
      options.eventType,
      options.occurredAt,
      options.payload,
      options.issueId,
      options.symbolication ?? null,
    ],
  );
  return id;
}

async function insertReproduction(
  dbClient: DbClient,
  issueId: string,
  generatedByUserId: string,
  options: ReproductionOptions,
): Promise<void> {
  await dbClient.pool.query(
    `INSERT INTO reproduction_tests
       ("id", "issue_id", "event_id", "generated_by_user_id", "language",
        "framework", "code", "has_redacted_steps", "generator_version",
        "status", "error_code", "error_message", "completed_at", "created_at")
     VALUES ($1, $2, $3, $4, 'typescript', 'playwright', $5, $6, 'gen@1',
             $7, $8, 'private reproduction failure', $9, $10)`,
    [
      randomUUID(),
      issueId,
      options.eventId,
      generatedByUserId,
      options.code,
      options.status === "ready",
      options.status,
      options.errorCode,
      options.completedAt,
      options.createdAt,
    ],
  );
}

async function setupProject(
  app: AppInstance,
  dbClient: DbClient,
): Promise<ProjectFixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = await signup(
    app,
    `export-owner-${stamp}@example.com`,
    "Export Owner",
  );
  const viewer = await signup(
    app,
    `export-viewer-${stamp}@example.com`,
    "Export Viewer",
  );
  const { workspaceId, projectId } = await createWorkspaceAndProject(
    app,
    cookiesHeader(owner.cookies),
    `Export ${stamp}`,
  );
  await MembershipRepo.insertMembership(dbClient.db, {
    workspaceId,
    userId: viewer.userId,
    role: "viewer",
  });
  const issueId = await insertIssue(dbClient, projectId, {
    title: 'TypeError <script>alert("title")</script>\r\n',
    normalizedMessage: "Normalized hostile message\r\n",
  });
  return {
    ownerCookie: cookiesHeader(owner.cookies),
    ownerId: owner.userId,
    viewerCookie: cookiesHeader(viewer.cookies),
    projectId,
    issueId,
  };
}

async function seedEvidence(
  app: AppInstance,
  dbClient: DbClient,
): Promise<
  ProjectFixture & {
    oldEventId: string;
    newestEventId: string;
    foreignEventId: string;
  }
> {
  const fixture = await setupProject(app, dbClient);
  const sessionId = await insertSession(dbClient, fixture.projectId);
  const oldEventId = await insertEvent(dbClient, fixture.projectId, sessionId, {
    id: OLDEST_EVENT_ID,
    issueId: fixture.issueId,
    sequenceNumber: 10,
    eventType: "exception",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {
      values: [{ type: "TypeError", value: "old occurrence" }],
    },
  });

  for (let sequence = 1; sequence <= 29; sequence += 1) {
    if (sequence === 10) {
      continue;
    }
    await insertEvent(dbClient, fixture.projectId, sessionId, {
      sequenceNumber: sequence,
      issueId: null,
      eventType: "message",
      occurredAt: `2026-09-18T09:${String(sequence).padStart(2, "0")}:00.000Z`,
      payload: {
        message: sequence === 15 ? "timeline <script>" : `timeline-${sequence}`,
        level: "info",
        secret: "telemetry-secret-token",
        comment: "comment-body-secret",
      },
    });
  }

  const newestEventId = await insertEvent(
    dbClient,
    fixture.projectId,
    sessionId,
    {
      id: NEWEST_EVENT_ID,
      issueId: fixture.issueId,
      sequenceNumber: 30,
      eventType: "exception",
      occurredAt: "2026-09-18T12:00:00.000Z",
      payload: {
        values: [
          {
            type: "TypeError",
            value: "new occurrence",
            stacktrace: {
              frames: [
                {
                  filename: "https://example.com/app.js",
                  function: "handleClick",
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                },
              ],
            },
          },
        ],
        mechanism: { secret: "telemetry-secret-token" },
        fingerprint: ["fingerprint-signature-secret"],
        commentBody: "comment-body-secret",
        reproductionCode: "playwright-code-secret",
      },
      symbolication: {
        status: "mapped",
        rawFrames: [
          {
            filename: "https://example.com/app.js",
            function: "handleClick",
            lineno: 42,
            colno: 7,
            inApp: true,
          },
        ],
        mappedFrames: [
          {
            filename: "src/app.tsx",
            source: "src/app.tsx",
            function: "handleClick",
            name: "handleClick",
            line: 12,
            column: 4,
            inApplication: true,
            mapped: true,
          },
        ],
        mappedFrameCount: 1,
      },
    },
  );

  for (let sequence = 31; sequence <= 38; sequence += 1) {
    await insertEvent(dbClient, fixture.projectId, sessionId, {
      sequenceNumber: sequence,
      issueId: null,
      eventType: "message",
      occurredAt: `2026-09-18T12:${String(sequence - 20).padStart(2, "0")}:00.000Z`,
      payload: {
        message: `after-${sequence}`,
        level: "info",
        token: "telemetry-secret-token",
      },
    });
  }

  const foreignIssueId = await insertIssue(dbClient, fixture.projectId, {
    title: "Foreign issue",
    normalizedMessage: "Foreign issue",
  });
  const foreignEventId = await insertEvent(
    dbClient,
    fixture.projectId,
    sessionId,
    {
      issueId: foreignIssueId,
      sequenceNumber: 40,
      eventType: "exception",
      occurredAt: "2026-09-18T13:00:00.000Z",
      payload: { values: [{ type: "Error", value: "foreign" }] },
    },
  );

  await insertReproduction(dbClient, fixture.issueId, fixture.ownerId, {
    eventId: null,
    status: "pending",
    errorCode: null,
    code: null,
    completedAt: null,
    createdAt: "2026-09-18T10:00:00.000Z",
  });
  await insertReproduction(dbClient, fixture.issueId, fixture.ownerId, {
    eventId: newestEventId,
    status: "ready",
    errorCode: null,
    code: "playwright-code-secret",
    completedAt: "2026-09-18T11:30:00.000Z",
    createdAt: "2026-09-18T11:00:00.000Z",
  });
  await insertReproduction(dbClient, fixture.issueId, fixture.ownerId, {
    eventId: null,
    status: "failed",
    errorCode: "REPRODUCTION_FAILED",
    code: null,
    completedAt: "2026-09-18T12:30:00.000Z",
    createdAt: "2026-09-18T12:00:00.000Z",
  });
  await dbClient.pool.query(
    `INSERT INTO issue_comments ("issue_id", "author_user_id", "body_markdown")
     VALUES ($1, $2, 'comment-body-secret')`,
    [fixture.issueId, fixture.ownerId],
  );

  return { ...fixture, oldEventId, newestEventId, foreignEventId };
}

describe("issue export integration (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${randomUUID()}/export`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("hides cross-workspace issues as NOT_FOUND", async () => {
    const owner = await signup(
      app,
      `cross-owner-${Date.now()}@example.com`,
      "Cross Owner",
    );
    const outsider = await signup(
      app,
      `cross-outsider-${Date.now()}@example.com`,
      "Cross Outsider",
    );
    const { projectId } = await createWorkspaceAndProject(
      app,
      cookiesHeader(owner.cookies),
      "Cross",
    );
    const issueId = await insertIssue(dbClient, projectId, {
      title: "Cross-tenant issue",
      normalizedMessage: "Cross-tenant issue",
    });
    await createWorkspaceAndProject(
      app,
      cookiesHeader(outsider.cookies),
      "Outsider",
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${issueId}/export`,
      headers: { cookie: cookiesHeader(outsider.cookies) },
    });
    expect(response.statusCode).toBe(404);
  });

  it("exports viewer-readable evidence with safe fallback, selection, and bounded timeline", async () => {
    const fixture = await seedEvidence(app, dbClient);
    const viewerResponse = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export`,
      headers: { cookie: fixture.viewerCookie },
    });
    expect(viewerResponse.statusCode).toBe(200);
    const body = viewerResponse.json() as {
      exportedAt: string;
      issue: Record<string, unknown>;
      occurrence: { eventId: string } | null;
      stack: {
        symbolicationStatus: string | null;
        rawFrames: Array<Record<string, unknown>>;
        mappedFrames: Array<Record<string, unknown>> | null;
        preferredStack: Array<Record<string, unknown>>;
      } | null;
      timeline: Array<Record<string, unknown>>;
      reproductions: Array<Record<string, unknown>>;
    };

    expect(body.occurrence?.eventId).toBe(NEWEST_EVENT_ID);
    expect(body.stack).toMatchObject({ symbolicationStatus: "mapped" });
    expect(body.stack?.rawFrames[0]).toMatchObject({
      filename: "https://example.com/app.js",
      function: "handleClick",
      lineno: 42,
    });
    expect(body.stack?.mappedFrames?.[0]).toMatchObject({
      source: "src/app.tsx",
      line: 12,
      column: 4,
    });
    expect(body.stack?.preferredStack[0]).toMatchObject({
      source: "src/app.tsx",
    });
    expect(body.timeline).toHaveLength(26);
    expect(body.timeline.map((item) => item["sequenceNumber"])).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 10),
    );
    expect(body.timeline.every((item) => !Object.hasOwn(item, "payload"))).toBe(
      true,
    );
    expect(body.reproductions.map((item) => item["status"])).toEqual([
      "failed",
      "ready",
      "pending",
    ]);
    expect(body.reproductions[0]?.["eventId"]).toBeNull();
    expect(body.reproductions[1]).not.toHaveProperty("code");
    expect(body.reproductions[1]).not.toHaveProperty("generatedBy");
    expect(body.reproductions[0]).not.toHaveProperty("errorMessage");
    expect(body.issue).not.toHaveProperty("assignee");

    const rawJson = viewerResponse.body;
    for (const secret of [
      "telemetry-secret-token",
      "fingerprint-signature-secret",
      "private-signature",
      "comment-body-secret",
      "playwright-code-secret",
    ]) {
      expect(rawJson).not.toContain(secret);
    }

    const disposition = String(viewerResponse.headers["content-disposition"]);
    expect(disposition).toBe(
      `attachment; filename="replaybug-issue-${fixture.issueId}.json"`,
    );
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).not.toContain("<script>");
    expect(disposition).not.toContain("title");

    const explicit = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export?eventId=${fixture.oldEventId}`,
      headers: { cookie: fixture.viewerCookie },
    });
    expect(explicit.statusCode).toBe(200);
    expect(
      (explicit.json() as { occurrence: { eventId: string } }).occurrence
        .eventId,
    ).toBe(OLDEST_EVENT_ID);

    const foreign = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export?eventId=${fixture.foreignEventId}`,
      headers: { cookie: fixture.viewerCookie },
    });
    expect(foreign.statusCode).toBe(404);

    const uiOnlyQuery = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export?event=${fixture.oldEventId}`,
      headers: { cookie: fixture.viewerCookie },
    });
    expect(uiOnlyQuery.statusCode).toBe(400);
  });

  it("is deterministic apart from exportedAt", async () => {
    const fixture = await seedEvidence(app, dbClient);
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export`,
      headers: { cookie: fixture.ownerCookie },
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export`,
      headers: { cookie: fixture.ownerCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const withoutExportedAt = (raw: string): string => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      delete parsed["exportedAt"];
      return JSON.stringify(parsed);
    };
    expect(withoutExportedAt(first.body)).toBe(withoutExportedAt(second.body));
  });

  it("returns metadata and nullable sections when retention removed all occurrences", async () => {
    const fixture = await setupProject(app, dbClient);
    await insertReproduction(dbClient, fixture.issueId, fixture.ownerId, {
      eventId: null,
      status: "failed",
      errorCode: "REPRODUCTION_FAILED",
      code: null,
      completedAt: "2026-09-18T12:30:00.000Z",
      createdAt: "2026-09-18T12:00:00.000Z",
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/issues/${fixture.issueId}/export`,
      headers: { cookie: fixture.viewerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      issue: { id: fixture.issueId },
      occurrence: null,
      stack: null,
      timeline: [],
      reproductions: [
        {
          eventId: null,
          status: "failed",
          errorCode: "REPRODUCTION_FAILED",
        },
      ],
    });
  });
});
