"use client";

/**
 * Better Auth official client (v1.7.5, matching the API).
 * Email/password only this block: no GitHub/OAuth, no magic link, no reset.
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
