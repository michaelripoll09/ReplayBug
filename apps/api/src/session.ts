import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import type { Auth } from "./auth.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Resolve the Better Auth session for a Fastify request. Returns null when unauthenticated. */
export async function getSessionUser(
  request: FastifyRequest,
  auth: Auth,
): Promise<SessionUser | null> {
  try {
    const headers = fromNodeHeaders(request.headers);
    const session = await auth.api.getSession({ headers });
    if (
      session === null ||
      session.user === null ||
      session.user === undefined
    ) {
      return null;
    }
    const user = session.user as unknown as {
      id?: unknown;
      email?: unknown;
      name?: unknown;
    };
    if (typeof user.id !== "string" || typeof user.email !== "string") {
      return null;
    }
    return {
      id: user.id,
      email: user.email,
      name: typeof user.name === "string" ? user.name : user.email,
    };
  } catch {
    return null;
  }
}
