"use client";

/**
 * Better Auth official client (v1.7.5, matching the API).
 * Email/password remains available regardless of optional GitHub OAuth.
 * `baseURL` points at the Fastify API; `credentials: include` keeps the
 * HttpOnly session cookie flowing. No auth state in localStorage.
 */
import { createAuthClient } from "better-auth/react";
import { getWebConfig } from "./config";

function authBaseUrl(): string {
  try {
    return getWebConfig().apiUrl;
  } catch {
    return "http://localhost:4001";
  }
}

export const authClient = createAuthClient({
  baseURL: authBaseUrl(),
  fetchOptions: {
    credentials: "include",
  },
});

export const signIn = authClient.signIn;
export const signUp = authClient.signUp;
export const signOut = authClient.signOut;

export interface AuthCapabilities {
  github: boolean;
}

/** Reads the server's public, credential-free authentication capability. */
export async function getAuthCapabilities(): Promise<AuthCapabilities> {
  try {
    const response = await fetch(`${authBaseUrl()}/api/v1/meta`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return { github: false };
    const payload: unknown = await response.json();
    const github =
      typeof payload === "object" &&
      payload !== null &&
      "auth" in payload &&
      typeof payload.auth === "object" &&
      payload.auth !== null &&
      "github" in payload.auth &&
      typeof payload.auth.github === "boolean"
        ? payload.auth.github
        : false;
    return { github };
  } catch {
    return { github: false };
  }
}
