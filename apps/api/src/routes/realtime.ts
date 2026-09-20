import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { sendDomainError } from "./helpers.js";
import { authRequired, notFound } from "../errors.js";
import { ProjectRepo, MembershipRepo } from "@replaybug/db";
import type { WorkspaceRole } from "@replaybug/contracts";
import {
  requireProjectAccess,
  requireWorkspaceCapability,
  requireWorkspaceMembership,
} from "../authz/guards.js";
import {
  SSE_HEARTBEAT_MS,
  type ProjectUpdatesBroker,
  type ValidatedProjectUpdate,
} from "../realtime/broker.js";

export interface RealtimeRouteDeps {
  db: Database;
  auth: Auth;
  broker: ProjectUpdatesBroker;
  /** Dashboard origins allowed credentialed browser access (CORS). */
  trustedOrigins: string[];
}

const errorJson = {
  type: "object",
  required: ["code", "message", "requestId"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    requestId: { type: "string" },
  },
} as const;

/**
 * Update types whose payload identifiers include the AI analysis id.
 * analysisId is projected only for these frames; other types never carry it.
 */
const AI_ANALYSIS_UPDATE_TYPES: ReadonlySet<ValidatedProjectUpdate["type"]> =
  new Set<ValidatedProjectUpdate["type"]>([
    "ai_analysis.ready",
    "ai_analysis.failed",
  ]);

function toStreamPayload(update: ValidatedProjectUpdate): string {
  return JSON.stringify({
    version: update.version,
    type: update.type,
    projectId: update.projectId,
    issueId: update.issueId,
    ...(update.eventId !== undefined ? { eventId: update.eventId } : {}),
    ...(update.analysisId !== undefined &&
    AI_ANALYSIS_UPDATE_TYPES.has(update.type)
      ? { analysisId: update.analysisId }
      : {}),
  });
}

/**
 * Project-scoped Server-Sent Events stream (invalidation only).
 *
 * Authz is enforced at connect: cookie session + project access +
 * `issue:read`. Every reconnect re-runs this handler, so role changes and
 * revocations take effect on the next connection (see
 * docs/architecture/realtime.md revocation note). Only minimal versioned
 * payloads cross the stream — never telemetry, stacks, comments or
 * secrets; receivers refetch canonical state via TanStack Query.
 *
 * Tags: Realtime.
 */
export async function registerRealtimeRoutes(
  app: AppInstance,
  deps: RealtimeRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/projects/:projectId/events/stream",
    {
      schema: {
        tags: ["Realtime"],
        produces: ["text/event-stream"],
        params: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", format: "uuid" } },
        },
        response: {
          200: { type: "string" },
          401: errorJson,
          403: errorJson,
          404: errorJson,
        },
      },
    },
    async (request, reply) => {
      const user = await getSessionUser(request, deps.auth);
      if (user === null) {
        await sendDomainError(request, reply, authRequired());
        return;
      }
      const params = request.params as { projectId: string };
      try {
        const project = await ProjectRepo.findProjectById(
          deps.db,
          params.projectId,
        );
        if (project === undefined) {
          await sendDomainError(request, reply, notFound("Project"));
          return;
        }
        const found = await MembershipRepo.findMembership(
          deps.db,
          project.workspaceId,
          user.id,
        );
        const membership = requireWorkspaceMembership(
          found === undefined
            ? undefined
            : {
                workspaceId: found.workspaceId,
                userId: found.userId,
                role: found.role as WorkspaceRole,
              },
        );
        requireProjectAccess(
          {
            workspaceId: membership.workspaceId,
            userId: membership.userId,
            role: membership.role,
          },
          { id: project.id, workspaceId: project.workspaceId },
        );
        requireWorkspaceCapability(membership, "issue:read");
      } catch (error) {
        await sendDomainError(request, reply, error);
        return;
      }

      reply.hijack();
      const raw = reply.raw;
      // Hijacked replies skip Fastify's onSend CORS hook, so credentialed
      // browser streams (EventSource withCredentials) need manual headers.
      // Only an explicitly trusted origin is echoed — never "*" with
      // credentials, never a reflected arbitrary origin.
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };
      const origin = request.headers.origin;
      if (typeof origin === "string" && deps.trustedOrigins.includes(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
        headers["Vary"] = "Origin";
      }
      raw.writeHead(200, headers);

      let closed = false;
      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      const write = (chunk: string): void => {
        if (closed) {
          return;
        }
        try {
          raw.write(chunk);
        } catch {
          cleanup();
        }
      };

      // Gate the ready frame on LISTEN establishment so every mutation
      // after `ready` is observable. When the database is unreachable the
      // stream still opens degraded (receivers refetch normally).
      const live = await deps.broker.whenReady();
      write(
        `event: ready\ndata: ${JSON.stringify({ status: live ? "connected" : "degraded", projectId: params.projectId })}\n\n`,
      );
      const unsubscribe = deps.broker.subscribe(params.projectId, (update) => {
        write(`event: project-update\ndata: ${toStreamPayload(update)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        write(": heartbeat\n\n");
      }, SSE_HEARTBEAT_MS);
      if (typeof heartbeat.unref === "function") {
        heartbeat.unref();
      }
      request.raw.on("close", cleanup);
    },
  );
}
