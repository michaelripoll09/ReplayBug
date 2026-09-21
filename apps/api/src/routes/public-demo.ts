import type { Database } from "@replaybug/db";
import type { ApiConfig } from "../config.js";
import type { AppInstance } from "../instance.js";
import {
  getPublicDemoConfig,
  getPublicDemoIssue,
  getPublicDemoOverview,
  getPublicDemoSession,
  listPublicDemoAi,
  listPublicDemoIssues,
  listPublicDemoOccurrences,
  listPublicDemoReleases,
  listPublicDemoReproductions,
  listPublicDemoSessions,
} from "../services/public-demo.js";

export interface PublicDemoRouteDeps {
  db: Database;
  config: Pick<ApiConfig, "demoMode" | "demoPublicKey" | "apiUrl">;
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

function params(request: { params: unknown }): { id: string } {
  const value = request.params;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string"
  ) {
    return { id: "" };
  }
  return { id: (value as { id: string }).id };
}

function disabled(requestId: string) {
  return {
    code: "PUBLIC_DEMO_DISABLED",
    message: "Public demo is disabled",
    requestId,
  };
}

function missing(requestId: string) {
  return {
    code: "PUBLIC_DEMO_NOT_FOUND",
    message: "Public demo resource was not found",
    requestId,
  };
}

/**
 * Anonymous, GET-only boundary. Every service first resolves the workspace
 * marker and then scopes any route identifier to the canonical demo project.
 * No authenticated route is reused and no mutation route is registered here.
 */
export async function registerPublicDemoRoutes(
  app: AppInstance,
  deps: PublicDemoRouteDeps,
): Promise<void> {
  const get = (
    path: string,
    handler: (id?: string) => Promise<unknown | null>,
  ): void => {
    app.get(
      path,
      { schema: { response: { 200: {}, 404: errorJson } } },
      async (request, reply) => {
        if (deps.config.demoMode !== true) {
          return reply.status(404).send(disabled(request.id));
        }
        const id = path.includes(":id") ? params(request).id : undefined;
        const value = await handler(id);
        if (value === null) {
          return reply.status(404).send(missing(request.id));
        }
        return reply.send(value);
      },
    );
  };

  get("/api/v1/public-demo/config", () =>
    getPublicDemoConfig(deps.db, deps.config.apiUrl, deps.config.demoPublicKey),
  );
  get("/api/v1/public-demo/overview", () => getPublicDemoOverview(deps.db));
  get("/api/v1/public-demo/issues", () => listPublicDemoIssues(deps.db));
  get("/api/v1/public-demo/issues/:id", (id) =>
    getPublicDemoIssue(deps.db, id ?? ""),
  );
  get("/api/v1/public-demo/issues/:id/occurrences", (id) =>
    listPublicDemoOccurrences(deps.db, id ?? ""),
  );
  get("/api/v1/public-demo/issues/:id/reproductions", (id) =>
    listPublicDemoReproductions(deps.db, id ?? ""),
  );
  get("/api/v1/public-demo/issues/:id/ai", (id) =>
    listPublicDemoAi(deps.db, id ?? ""),
  );
  get("/api/v1/public-demo/sessions", () => listPublicDemoSessions(deps.db));
  get("/api/v1/public-demo/sessions/:id", (id) =>
    getPublicDemoSession(deps.db, id ?? ""),
  );
  get("/api/v1/public-demo/releases", () => listPublicDemoReleases(deps.db));
}
