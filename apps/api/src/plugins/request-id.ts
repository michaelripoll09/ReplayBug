import { type FastifyReply, type FastifyRequest } from "fastify";
import { type AppInstance } from "../instance.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "../request-id.js";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

/** Attach a validated-or-generated request ID and echo it on every response. */
export async function registerRequestId(app: AppInstance): Promise<void> {
  app.decorateRequest("requestId", "");

  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const incoming = request.headers[REQUEST_ID_HEADER];
      const first = Array.isArray(incoming) ? incoming[0] : incoming;
      const requestId = resolveRequestId(first);
      request.requestId = requestId;
      // NOTE: reply.header() returns the reply object itself, which must
      // never be awaited (awaiting it stalls the hook indefinitely). The
      // call is synchronous; there is nothing to wait for.
      reply.header(REQUEST_ID_HEADER, requestId);
    },
  );
}
