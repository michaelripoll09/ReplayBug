import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, session, user, verification } from "./auth-schema.js";
import type { ApiConfig } from "./config.js";
import type { Database } from "@replaybug/db";

export interface AuthSession {
  user: { id: string; email: string; name: string };
  session: unknown;
}

/** Minimal Better Auth surface used by the API (structural, version-tolerant). */
export interface Auth {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (args: { headers: Headers }) => Promise<AuthSession | null>;
  };
}

export interface AuthContext {
  auth: Auth;
}

/**
 * Create the Better Auth instance (email/password, PG persistence).
 * - No OAuth this block, no fake reset.
 * - HttpOnly cookies, Secure in production, SameSite Lax, rotation via
 *   session updateAge.
 * - All auth config comes from the validated ApiConfig boundary.
 */
export function createAuth(db: Database, config: ApiConfig): Auth {
  const instance = betterAuth({
    secret: config.authSecret,
    baseURL: config.apiUrl,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    advanced: {
      useSecureCookies: config.nodeEnv === "production",
      cookies: {
        session_token: {
          attributes: {
            httpOnly: true,
            secure: config.nodeEnv === "production",
            sameSite: "lax",
            path: "/",
          },
        },
        session_data: {
          attributes: {
            httpOnly: true,
            secure: config.nodeEnv === "production",
            sameSite: "lax",
            path: "/",
          },
        },
      },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
      },
    }),
    rateLimit: {
      enabled: config.nodeEnv !== "test",
      window: 60,
      max: 100,
    },
  });
  // Boundary adapter: Better Auth's generic Auth type varies by options;
  // the API only depends on the structural surface above.
  return instance as unknown as Auth;
}
