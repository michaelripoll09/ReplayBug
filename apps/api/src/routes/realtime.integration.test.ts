import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MembershipRepo, type DbClient } from "@replaybug/db";
import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import { validateProjectUpdate } from "../realtime/broker.js";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";

async function signup(
  app: AppInstance,
  email: string,
): Promise<{ cookies: string[]; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: PASSWORD, name: "Stream Tester" },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${res.body}`);
  }
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw)
    ? (raw as string[])
    : raw !== undefined
      ? [String(raw)]
      : [];
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { cookie: cookiesHeader(cookies) },
  });
  return { cookies, userId: (me.json() as { id: string }).id };
}

interface SseFrame {
  event: string | null;
  data: string;
}

function parseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (part === "" || part.startsWith(":")) {
      continue;
    }
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

async function collectFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  want: number,
  timeoutMs: number,
): Promise<SseFrame[]> {
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let rest = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < want && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) =>
        setTimeout(() => resolve({ done: false }), Math.max(remaining, 0)),
      ),
    ]);
    if (read.done) {
      break;
    }
    if (read.value === undefined) {
      break;
    }
    rest += decoder.decode(read.value, { stream: true });
    const parsed = parseFrames(rest);
    rest = parsed.rest;
    frames.push(...parsed.frames);
  }
  return frames;
}

/**
 * Block 6 realtime SSE (T12) over real HTTP + real PostgreSQL NOTIFY:
 * auth at connect, minimal versioned payloads, multi-client isolation and
 * malformed-payload filtering.
 */
describe("realtime SSE integration (real HTTP + PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;
  let baseUrl: string;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("server did not bind");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  async function setup(): Promise<{
    cookie: string;
    memberCookie: string;
    memberId: string;
    projectA: string;
    projectB: string;
    issueId: string;
    tagId: string;
  }> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = await signup(app, `sown-${stamp}@example.com`);
    const member = await signup(app, `smem-${stamp}@example.com`);
    const cookie = cookiesHeader(owner.cookies);

    const wsRes = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: { cookie },
      payload: { name: `Stream WS ${stamp}` },
    });
    const workspaceId = (wsRes.json() as { id: string }).id;
    const mkProject = async (name: string): Promise<string> => {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects`,
        headers: { cookie },
        payload: { name: `${name} ${stamp}` },
      });
      return (r.json() as { project: { id: string } }).project.id;
    };
    const projectA = await mkProject("StreamProjA");
    const projectB = await mkProject("StreamProjB");

    await MembershipRepo.insertMembership(dbClient.db, {
      workspaceId,
      userId: member.userId,
      role: "member",
    });

    const issueId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issues ("id", "project_id", "fingerprint",
         "fingerprint_signature", "type", "title", "normalized_message",
         "status", "severity", "first_seen_at", "last_seen_at",
         "occurrence_count", "affected_session_count")
       VALUES ($1, $2, '${"c".repeat(64)}', 'sig', 'exception',
               'Streamed failure', 'Streamed failure', 'open', 'error',
               now(), now(), 1, 1)`,
      [issueId, projectA],
    );
    const tagId = randomUUID();
    await dbClient.pool.query(
      `INSERT INTO issue_tags ("id", "project_id", "name", "slug")
       VALUES ($1, $2, 'Stream', 'stream')`,
      [tagId, projectA],
    );
    return {
      cookie,
      memberCookie: cookiesHeader(member.cookies),
      memberId: member.userId,
      projectA,
      projectB,
      issueId,
      tagId,
    };
  }

  async function openStream(
    projectId: string,
    cookie: string,
    origin?: string,
  ): Promise<{
    response: Response;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    cancel: () => Promise<void>;
  }> {
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/v1/projects/${projectId}/events/stream`,
      {
        headers: {
          cookie,
          ...(origin !== undefined ? { origin } : {}),
        },
        signal: controller.signal,
      },
    );
    if (response.body === null) {
      throw new Error("stream has no body");
    }
    return {
      response,
      reader: response.body.getReader(),
      cancel: async () => {
        controller.abort();
        try {
          await response.body?.cancel();
        } catch {
          // Already torn down.
        }
      },
    };
  }

  it("rejects unauthenticated and unknown-project streams", async () => {
    const anon = await fetch(
      `${baseUrl}/api/v1/projects/${randomUUID()}/events/stream`,
    );
    expect(anon.status).toBe(401);
    await anon.body?.cancel();

    const { cookie } = await setup();
    const missing = await fetch(
      `${baseUrl}/api/v1/projects/${randomUUID()}/events/stream`,
      { headers: { cookie } },
    );
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  });

  it("streams mutation updates to project subscribers only", async () => {
    const { memberCookie, memberId, projectA, projectB, issueId, tagId } =
      await setup();

    const streamA = await openStream(
      projectA,
      memberCookie,
      "http://localhost:3000",
    );
    const streamB = await openStream(projectB, memberCookie);
    try {
      expect(streamA.response.status).toBe(200);
      expect(streamA.response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      // Hijacked replies skip the CORS hook: trusted origins are echoed
      // manually so credentialed browser streams are not blocked.
      expect(streamA.response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:3000",
      );
      expect(
        streamA.response.headers.get("access-control-allow-credentials"),
      ).toBe("true");
      // Ready frame first.
      const ready = await collectFrames(streamA.reader, 1, 5000);
      expect(ready[0]).toMatchObject({ event: "ready" });

      const trigger = async (
        method: "PATCH" | "POST" | "PUT",
        url: string,
        payload: Record<string, unknown>,
      ): Promise<void> => {
        const res = await app.inject({
          method,
          url,
          headers: { cookie: memberCookie },
          payload,
        });
        expect(res.statusCode).toBeLessThan(300);
      };
      await trigger("PATCH", `/api/v1/issues/${issueId}/status`, {
        status: "investigating",
      });
      await trigger("POST", `/api/v1/issues/${issueId}/comments`, {
        body: "Streaming note.",
      });
      await trigger("PATCH", `/api/v1/issues/${issueId}/assignee`, {
        userId: memberId,
      });
      await trigger("PUT", `/api/v1/issues/${issueId}/tags/${tagId}`, {});

      // Ready + 4 mutation events.
      const frames = await collectFrames(streamA.reader, 5, 10000);
      const updates = frames.filter((f) => f.event === "project-update");
      expect(updates).toHaveLength(4);
      const types = updates
        .map((f) => (JSON.parse(f.data) as { type: string }).type)
        .sort();
      expect(types).toEqual(
        [
          "assignment.changed",
          "comment.created",
          "issue.updated",
          "tags.changed",
        ].sort(),
      );
      for (const update of updates) {
        const payload = JSON.parse(update.data) as Record<string, unknown>;
        expect(payload).toMatchObject({
          version: 1,
          projectId: projectA,
          issueId,
        });
        expect(payload).not.toHaveProperty("payload_json");
        expect(payload).not.toHaveProperty("payloadJson");
        expect(payload).not.toContain("Streaming note.");
      }

      // Project B stream stays silent (isolation).
      const bFrames = await collectFrames(streamB.reader, 2, 1500);
      const bUpdates = bFrames.filter((f) => f.event === "project-update");
      expect(bUpdates).toHaveLength(0);
    } finally {
      await streamA.cancel();
      await streamB.cancel();
    }
  }, 30000);

  it("forwards identifier-only ai_analysis updates and validates their ids", async () => {
    const { memberCookie, projectA, issueId } = await setup();
    const stream = await openStream(projectA, memberCookie);
    try {
      const ready = await collectFrames(stream.reader, 1, 5000);
      expect(ready[0]).toMatchObject({ event: "ready" });

      const readyAnalysisId = randomUUID();
      const failedAnalysisId = randomUUID();
      const eventId = randomUUID();
      await dbClient.pool.query(
        `SELECT pg_notify('replaybug_project_updates', $1)`,
        [
          JSON.stringify({
            version: 1,
            type: "ai_analysis.ready",
            projectId: projectA,
            issueId,
            eventId,
            analysisId: readyAnalysisId,
          }),
        ],
      );
      await dbClient.pool.query(
        `SELECT pg_notify('replaybug_project_updates', $1)`,
        [
          JSON.stringify({
            version: 1,
            type: "ai_analysis.failed",
            projectId: projectA,
            issueId,
            analysisId: failedAnalysisId,
          }),
        ],
      );

      const frames = await collectFrames(stream.reader, 3, 10000);
      const updates = frames.filter((f) => f.event === "project-update");
      expect(updates).toHaveLength(2);
      const payloads = updates.map(
        (update) => JSON.parse(update.data) as Record<string, unknown>,
      );
      const readyPayload = payloads.find(
        (payload) => payload["type"] === "ai_analysis.ready",
      );
      const failedPayload = payloads.find(
        (payload) => payload["type"] === "ai_analysis.failed",
      );

      // The streamed frame carries the validated analysisId so clients can
      // invalidate exactly that analysis. The event id survives too; the
      // field set stays identifier-only.
      expect(readyPayload).toMatchObject({
        version: 1,
        type: "ai_analysis.ready",
        projectId: projectA,
        issueId,
        eventId,
        analysisId: readyAnalysisId,
      });
      expect(Object.keys(readyPayload ?? {}).sort()).toEqual(
        [
          "analysisId",
          "eventId",
          "issueId",
          "projectId",
          "type",
          "version",
        ].sort(),
      );
      expect(failedPayload).toMatchObject({
        version: 1,
        type: "ai_analysis.failed",
        projectId: projectA,
        issueId,
        analysisId: failedAnalysisId,
      });
      expect(Object.keys(failedPayload ?? {}).sort()).toEqual(
        ["analysisId", "issueId", "projectId", "type", "version"].sort(),
      );
      for (const payload of payloads) {
        // Identifier-only: no result text, evidence, or provider output.
        expect(payload).not.toHaveProperty("summary");
        expect(payload).not.toHaveProperty("evidence");
        expect(payload).not.toHaveProperty("suspectedCause");
        expect(payload).not.toHaveProperty("content");
      }
    } finally {
      await stream.cancel();
    }

    // The broker accepts both AI update types with an identifier-only payload.
    expect(
      validateProjectUpdate({
        version: 1,
        type: "ai_analysis.failed",
        projectId: projectA,
        issueId,
        analysisId: randomUUID(),
      }),
    ).toMatchObject({ version: 1, type: "ai_analysis.failed" });
    expect(
      validateProjectUpdate({
        version: 1,
        type: "ai_analysis.ready",
        projectId: projectA,
        issueId,
        analysisId: "not-a-uuid",
      }),
    ).toBeNull();
  }, 30000);

  it("projects analysisId only for ai_analysis frames", async () => {
    const { memberCookie, projectA, issueId } = await setup();
    const stream = await openStream(projectA, memberCookie);
    try {
      const ready = await collectFrames(stream.reader, 1, 5000);
      expect(ready[0]).toMatchObject({ event: "ready" });

      // A non-AI type that somehow carries an analysis id must not leak it:
      // the projection forwards analysisId only for the AI analysis frames.
      await dbClient.pool.query(
        `SELECT pg_notify('replaybug_project_updates', $1)`,
        [
          JSON.stringify({
            version: 1,
            type: "issue.updated",
            projectId: projectA,
            issueId,
            analysisId: randomUUID(),
          }),
        ],
      );

      const frames = await collectFrames(stream.reader, 2, 10000);
      const updates = frames.filter((f) => f.event === "project-update");
      expect(updates).toHaveLength(1);
      const payload = JSON.parse(updates[0]?.data ?? "{}") as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        version: 1,
        type: "issue.updated",
        projectId: projectA,
        issueId,
      });
      expect(payload).not.toHaveProperty("analysisId");
    } finally {
      await stream.cancel();
    }
  }, 30000);

  it("drops malformed channel payloads instead of forwarding them", async () => {
    const { memberCookie, projectA } = await setup();
    const stream = await openStream(projectA, memberCookie);
    try {
      const ready = await collectFrames(stream.reader, 1, 5000);
      expect(ready[0]).toMatchObject({ event: "ready" });

      await dbClient.pool.query(
        `SELECT pg_notify('replaybug_project_updates', 'not-json{{{')`,
      );
      await dbClient.pool.query(
        `SELECT pg_notify('replaybug_project_updates', $1)`,
        [
          JSON.stringify({
            version: 1,
            type: "issue.updated",
            projectId: projectA,
            issueId: "not-a-uuid",
          }),
        ],
      );
      const frames = await collectFrames(stream.reader, 2, 1500);
      expect(frames.filter((f) => f.event === "project-update")).toHaveLength(
        0,
      );
    } finally {
      await stream.cancel();
    }
  });
});
