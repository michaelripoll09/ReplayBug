import { fromNodeHeaders } from "better-auth/node";
import type { AppInstance } from "../instance.js";
import type { Auth } from "../auth.js";

/**
 * Better Auth handler mounted at /api/auth/*. Forwards to Better Auth and
 * echoes Set-Cookie/headers. CSRF protection stays enabled (Better Auth
 * default); never disabled. Tag: Auth.
 */
export async function registerAuthRoutes(
  app: AppInstance,
  auth: Auth,
): Promise<void> {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: {
      tags: ["Auth"],
      hide: false,
    },
    handler: async (request, reply) => {
      try {
        const url = new URL(request.url, "http://localhost");
        const headers = fromNodeHeaders(request.headers);
        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          ...(request.body !== undefined &&
          request.body !== null &&
          request.method !== "GET" &&
          request.method !== "HEAD"
            ? { body: JSON.stringify(request.body) }
            : {}),
        });
        const response = await auth.handler(req);
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          // Fastify lowercases set-cookie handling; forward all headers.
          if (key.toLowerCase() === "set-cookie") {
            return;
          }
          reply.header(key, value);
        });
        const setCookies = response.headers.getSetCookie?.();
        if (Array.isArray(setCookies) && setCookies.length > 0) {
          reply.header("set-cookie", setCookies);
        } else {
          const single = response.headers.get("set-cookie");
          if (typeof single === "string" && single.length > 0) {
            reply.header("set-cookie", single);
          }
        }
        const text = response.body !== null ? await response.text() : null;
        if (text === null || text === "") {
          await reply.send();
          return;
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          await reply.send(JSON.parse(text) as unknown);
          return;
        }
        await reply.send(text);
      } catch (error) {
        request.log.error({ err: error }, "Authentication handler error");
        await reply.status(500).send({
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          requestId:
            (request as unknown as { requestId?: string }).requestId ??
            "unknown",
        });
      }
    },
  });
}
