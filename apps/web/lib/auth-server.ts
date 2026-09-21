import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Server-side session validation via cookie-forwarding.
 *
 * - No manual cookie decode, no parallel auth, no DB access from Next.js.
 * - Forwards the incoming `cookie` header to `GET /api/v1/me` on the Fastify
 *   API; the backend remains the RBAC authority.
 * - No sensitive render happens before this check in protected layouts.
 */

export interface ServerUser {
  id: string;
  email: string;
  name: string;
}

function apiBase(): string {
  const raw =
    process.env["NEXT_PUBLIC_REPLAYBUG_API_URL"]?.trim() ||
    "http://localhost:4001";
  return raw.replace(/\/+$/, "");
}

async function fetchMe(cookieHeader: string): Promise<ServerUser | null> {
  if (cookieHeader.length === 0) {
    return null;
  }
  try {
    const incomingHeaders = await headers();
    const requestId = incomingHeaders.get("x-request-id") ?? undefined;
    const res = await fetch(`${apiBase()}/api/v1/me`, {
      method: "GET",
      headers: {
        cookie: cookieHeader,
        ...(requestId !== undefined ? { "x-request-id": requestId } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as Partial<ServerUser>;
    if (typeof body.id !== "string" || typeof body.email !== "string") {
      return null;
    }
    return {
      id: body.id,
      email: body.email,
      name: typeof body.name === "string" ? body.name : body.email,
    };
  } catch {
    return null;
  }
}

/** Current session user or null. Server components only. */
export async function getServerSessionUser(): Promise<ServerUser | null> {
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return fetchMe(cookieHeader);
}

/** Redirect to /login when unauthenticated. Returns the user otherwise. */
export async function requireServerSession(): Promise<ServerUser> {
  const user = await getServerSessionUser();
  if (user === null) {
    redirect("/login");
  }
  return user;
}

/** Fetch JSON from the API with the incoming cookies forwarded. */
export async function apiFetchServer(
  path: string,
  init?: { method?: string | undefined; body?: unknown },
): Promise<Response> {
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const hasBody = init?.body !== undefined;
  return fetch(`${apiBase()}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      cookie: cookieHeader,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(init?.body) } : {}),
    cache: "no-store",
  });
}
