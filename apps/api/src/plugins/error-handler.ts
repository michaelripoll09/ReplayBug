import {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { type ErrorEnvelope } from "@replaybug/contracts";
import { type AppInstance } from "../instance.js";

function requestIdOf(request: FastifyRequest): string {
  const candidate = (request as FastifyRequest & { requestId?: unknown })
    .requestId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : "unknown";
}

/**
 * Global error handler. Every error uses the shared contracts envelope
 * {code, message, requestId, details?}. Unexpected errors return a generic
 * safe message; full diagnostics go to structured logs only (no stack leak).
 */
export async function registerErrorHandler(app: AppInstance): Promise<void> {
  app.setErrorHandler(
    async (
      error: FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const requestId = requestIdOf(request);

      if (error.validation !== undefined) {
        const body: ErrorEnvelope = {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          requestId,
          details: error.validation,
        };
        await reply.status(400).send(body);
        return;
      }

      const statusCode =
        typeof error.statusCode === "number" &&
        error.statusCode >= 400 &&
        error.statusCode < 600
          ? error.statusCode
          : 500;

      if (statusCode < 500) {
        const body: ErrorEnvelope = {
          code: error.code ?? "REQUEST_ERROR",
          message: error.message,
          requestId,
        };
        await reply.status(statusCode).send(body);
        return;
      }

      request.log.error({ err: error, requestId }, "Unhandled API error");
      const body: ErrorEnvelope = {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
        requestId,
      };
      await reply.status(500).send(body);
    },
  );

  app.setNotFoundHandler(
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body: ErrorEnvelope = {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        requestId: requestIdOf(request),
      };
      await reply.status(404).send(body);
    },
  );
}
