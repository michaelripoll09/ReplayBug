import { type FastifyInstance, type RawServerDefault } from "fastify";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type Logger } from "@replaybug/observability";

/**
 * Concrete Fastify instance type for the ReplayBug API.
 *
 * The server runs with a Pino logger created by `@replaybug/observability`
 * (pino v10, whose `Logger` requires `msgPrefix`), which is not identical to
 * Fastify's default `FastifyBaseLogger`. All route/plugin registration
 * helpers accept this alias so the logger generic stays unified instead of
 * decaying into variance errors under `exactOptionalPropertyTypes`.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
