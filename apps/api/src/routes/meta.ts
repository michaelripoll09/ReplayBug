import { type AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";
import { authRequired } from "../errors.js";
import { sendDomainError } from "./helpers.js";
import type { ApiConfig } from "../config.js";

export interface MetaRouteOptions {
  version: string;
  environment: string;
  auth: Auth;
  config: Pick<ApiConfig, "aiAnalysis">;
}

/** GET /api/v1/meta — versioned service metadata for operators and CI. */
export async function registerMetaRoutes(
  app: AppInstance,
  options: MetaRouteOptions,
): Promise<void> {
  app.get(
    "/api/v1/meta",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["service", "version", "environment"],
            properties: {
              service: { const: "api" },
              version: { type: "string" },
              environment: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      service: "api" as const,
      version: options.version,
      environment: options.environment,
    }),
  );

  app.get(
    "/api/v1/meta/ai-analysis",
    {
      schema: {
        tags: ["Meta"],
        response: {
          200: {
            type: "object",
            required: ["aiAnalysis"],
            properties: {
              aiAnalysis: {
                type: "object",
                required: ["configured", "status"],
                properties: {
                  configured: { type: "boolean" },
                  status: {
                    type: "string",
                    enum: ["disabled", "configured", "misconfigured"],
                  },
                  model: { type: "string" },
                },
              },
            },
          },
          401: {
            type: "object",
            required: ["code", "message", "requestId"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              requestId: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getSessionUser(request, options.auth);
        if (user === null) {
          throw authRequired();
        }
        const capability = options.config.aiAnalysis;
        await reply.send({
          aiAnalysis: {
            configured: capability.configured,
            status: capability.status,
            ...(capability.model !== undefined
              ? { model: capability.model }
              : {}),
          },
        });
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );
}
