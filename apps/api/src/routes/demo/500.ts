import type { AppInstance } from "../../instance.js";

export async function registerDemo500Route(app: AppInstance): Promise<void> {
  app.post("/api/demo/500-endpoint", async (_request, reply) => {
    // Always return 500 for demo purposes
    return reply.status(500).send({
      error: "DEMO: Intentional 500 error for telemetry testing",
      timestamp: new Date().toISOString(),
    });
  });
}
