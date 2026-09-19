import * as React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@replaybug/api-client";
import { SecretTokensSettings } from "./secret-tokens-settings";

const { mockGet, mockPost, mockUnwrap } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockUnwrap: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    client: {
      GET: mockGet,
      POST: mockPost,
    },
    unwrap: mockUnwrap,
  },
}));

interface TokenMeta {
  id: string;
  projectId: string;
  kind: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const META: TokenMeta = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "proj-1",
  kind: "secret",
  name: "ci-upload",
  prefix: "abcdef12",
  createdAt: "2026-09-18T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

const FULL_TOKEN = "rb_sk_abcdef12_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function ok<T>(data: T): { data: T; error: undefined; response: Response } {
  return { data, error: undefined, response: new Response() };
}

function setup(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return client;
}

function wrapper(
  client: QueryClient,
): ({ children }: { children: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function cacheDump(client: QueryClient): string {
  return JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
  );
}

/**
 * RS-10 secret-token settings: 403-on-all graceful for member/viewer,
 * owner/admin create with a one-time reveal, plaintext cleared on close and
 * never persisted to storage/URL/query cache.
 */
describe("secret tokens settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a graceful restricted notice on 403 (member/viewer)", async () => {
    mockGet.mockResolvedValue({
      data: undefined,
      error: { code: "FORBIDDEN" },
      response: new Response(),
    });
    mockUnwrap.mockRejectedValue(
      new ApiError({
        code: "FORBIDDEN",
        message: "Forbidden",
        status: 403,
        requestId: "req-1",
      }),
    );
    const client = setup();
    render(<SecretTokensSettings projectId="proj-1" role="viewer" />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => {
      expect(screen.getByText(/restricted/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Token name")).not.toBeInTheDocument();
  });

  it("creates a token with a one-time reveal and clears plaintext on close", async () => {
    mockGet.mockResolvedValue(ok([META]));
    mockPost.mockResolvedValue(ok({ ...META, token: FULL_TOKEN }));
    const client = setup();
    render(<SecretTokensSettings projectId="proj-1" role="owner" />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => {
      expect(screen.getByText("ci-upload")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "deploy" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create secret token" }),
    );

    // One-time reveal: shown once, copy button, env-var hint, no shell cmd.
    const shown = await screen.findByText(FULL_TOKEN);
    expect(shown).toBeInTheDocument();
    expect(screen.getByText(/shown once/)).toBeInTheDocument();
    expect(screen.getByText(/REPLAYBUG_AUTH_TOKEN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    // Usage hint only — never a giant committable shell command.
    expect(screen.getByRole("dialog").textContent).not.toContain("&&");
    expect(mockPost).toHaveBeenCalledWith(
      "/api/v1/projects/{projectId}/secret-tokens",
      expect.objectContaining({
        params: { path: { projectId: "proj-1" } },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByText(FULL_TOKEN)).not.toBeInTheDocument();
    });

    // Plaintext never persisted: storage, URL, or the query cache.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain(FULL_TOKEN);
    expect(window.location.hash).not.toContain(FULL_TOKEN);
    expect(cacheDump(client)).not.toContain(FULL_TOKEN);
    for (let i = 0; i < localStorage.length; i += 1) {
      expect(localStorage.getItem(localStorage.key(i) ?? "")).not.toContain(
        FULL_TOKEN,
      );
    }
  });

  it("revokes with targeted invalidation and marks the token revoked", async () => {
    let revoked = false;
    const revokedMeta: TokenMeta = {
      ...META,
      revokedAt: "2026-09-18T13:00:00.000Z",
    };
    mockGet.mockImplementation(() =>
      Promise.resolve(ok([revoked ? revokedMeta : META])),
    );
    // The mock flips state on the revoke POST itself, so any refetch the
    // component triggers after the mutation observes the revoked row —
    // no test-side flag race with invalidation refetches.
    mockPost.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith("/revoke")) {
        revoked = true;
      }
      return Promise.resolve(ok(revokedMeta));
    });
    const client = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<SecretTokensSettings projectId="proj-1" role="admin" />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => {
      expect(screen.getByText("ci-upload")).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Revoke token ci-upload" }),
    );
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        "/api/v1/projects/{projectId}/secret-tokens/{tokenId}/revoke",
        expect.objectContaining({
          params: { path: { projectId: "proj-1", tokenId: META.id } },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Revoked")).toBeInTheDocument();
    });
    // Targeted invalidation: the secret-tokens key only, never global.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["projects", "proj-1", "secret-tokens"],
    });
    for (const call of invalidate.mock.calls) {
      expect(call[0]).toHaveProperty("queryKey");
    }
  });

  it("hides create/revoke controls from members without crashing", async () => {
    mockGet.mockResolvedValue(ok([META]));
    const client = setup();
    render(<SecretTokensSettings projectId="proj-1" role="member" />, {
      wrapper: wrapper(client),
    });
    await waitFor(() => {
      expect(screen.getByText("ci-upload")).toBeInTheDocument();
    });
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token name")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Revoke token/ }),
    ).not.toBeInTheDocument();
  });
});
