import { type AppInstance } from "../instance.js";

export interface MetaRouteOptions {
  version: string;
  environment: string;
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
}
