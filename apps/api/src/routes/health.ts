import { type AppInstance } from "../instance.js";

export type ArtifactStorageStatus = "up" | "down" | "unknown";

export interface HealthRouteOptions {
  checkDatabase: () => Promise<boolean>;
  /**
   * RS-13 artifact-storage probe. Optional: when omitted the API reports
   * `"unknown"` (storage not probed by this process). The probe must never
   * throw — a throwing probe is reported as `"down"`.
   *
   * Storage NEVER drives the ready status code: readiness stays a database
   * question (master spec 36.3/54 — ingest continues while storage is down).
   * The field is informational so operators can see degraded symbolication
   * (upload 503, worker raw fallback) without the API looking not-ready.
   */
  checkArtifactStorage?: () => Promise<boolean>;
}

/**
 * Foundation routes only:
 * - GET /health/live  (no database access)
 * - GET /health/ready (PostgreSQL check: 200 ready / 503 not-ready,
 *   plus an informational artifact-storage status that never flips readiness)
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

  const artifactStorageStatusJson = {
    type: "string",
    enum: ["up", "down", "unknown"],
  } as const;

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
                required: ["database", "artifactStorage"],
                properties: {
                  database: { const: "up" },
                  artifactStorage: artifactStorageStatusJson,
                },
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
                required: ["database", "artifactStorage"],
                properties: {
                  database: { const: "down" },
                  artifactStorage: artifactStorageStatusJson,
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const up = await options.checkDatabase();
      const artifactStorage = await probeArtifactStorage(options);
      if (up) {
        await reply.status(200).send({
          status: "ready" as const,
          checks: { database: "up" as const, artifactStorage },
        });
        return;
      }
      await reply.status(503).send({
        status: "not-ready" as const,
        checks: { database: "down" as const, artifactStorage },
      });
    },
  );
}

/**
 * Run the optional storage probe without ever letting it break readiness:
 * omitted probes report "unknown", throwing probes report "down".
 */
async function probeArtifactStorage(
  options: HealthRouteOptions,
): Promise<ArtifactStorageStatus> {
  if (options.checkArtifactStorage === undefined) {
    return "unknown";
  }
  try {
    return (await options.checkArtifactStorage()) ? "up" : "down";
  } catch {
    return "down";
  }
}
