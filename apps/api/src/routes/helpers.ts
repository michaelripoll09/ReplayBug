import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, statusForCode } from "../errors.js";

function requestIdOf(request: FastifyRequest): string {
  const candidate = (request as FastifyRequest & { requestId?: unknown })
    .requestId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : "unknown";
}

/** Send a domain-safe error envelope. Never leaks SQL/stack/hash/cookie. */
export async function sendDomainError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): Promise<void> {
  const requestId = requestIdOf(request);
  if (error instanceof DomainError) {
    const status = statusForCode(error.code);
    const body: Record<string, unknown> = {
      code: error.code,
      message: error.message,
      requestId,
    };
    if (error.details !== undefined) {
      body["details"] = error.details;
    }
    await reply.status(status).send(body);
    return;
  }
  if (error instanceof z.ZodError) {
    await reply.status(400).send({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      requestId,
      details: error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  request.log.error({ err: error, requestId }, "Unhandled route error");
  await reply.status(500).send({
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
    requestId,
  });
}

export function getRequestId(request: FastifyRequest): string {
  return requestIdOf(request);
}
