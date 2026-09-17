import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";
import { getSessionUser } from "../session.js";

export interface MeRouteDeps {
  auth: Auth;
}

/** GET /api/v1/me — 401 when no session. Tag: Auth. */
export async function registerMeRoutes(
  app: AppInstance,
  deps: MeRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/me",
    {
      schema: {
        tags: ["Auth"],
        response: {
          200: {
            type: "object",
            required: ["id", "email", "name"],
            properties: {
              id: { type: "string" },
              email: { type: "string" },
              name: { type: "string" },
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
      const user = await getSessionUser(request, deps.auth);
      if (user === null) {
        const requestId =
          (request as unknown as { requestId: string }).requestId ?? "unknown";
        await reply.status(401).send({
          code: "AUTH_REQUIRED",
          message: "Authentication required",
          requestId,
        });
        return;
      }
      await reply.send({ id: user.id, email: user.email, name: user.name });
    },
  );
}
