import { type AppInstance } from "../instance.js";

export interface HealthRouteOptions {
  checkDatabase: () => Promise<boolean>;
}

/**
 * Foundation routes only:
 * - GET /health/live  (no database access)
 * - GET /health/ready (PostgreSQL check: 200 ready / 503 not-ready)
 */
export async function registerHealthRoutes(
  app: AppInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["status", "service"],
            properties: {
              status: { const: "ok" },
              service: { const: "api" },
            },
          },
        },
      },
    },
    async () => ({ status: "ok" as const, service: "api" as const }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["status", "checks"],
            properties: {
              status: { const: "ready" },
              checks: {
                type: "object",
                required: ["database"],
                properties: { database: { const: "up" } },
              },
            },
          },
          503: {
            type: "object",
            required: ["status", "checks"],
            properties: {
              status: { const: "not-ready" },
              checks: {
                type: "object",
                required: ["database"],
                properties: { database: { const: "down" } },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const up = await options.checkDatabase();
      if (up) {
        await reply.status(200).send({
          status: "ready" as const,
          checks: { database: "up" as const },
        });
        return;
      }
      await reply.status(503).send({
        status: "not-ready" as const,
        checks: { database: "down" as const },
      });
    },
  );
}
