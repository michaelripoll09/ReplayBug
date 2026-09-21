import { afterEach, describe, expect, it } from "vitest";
import { createApiClient, type PreflightEntry } from "./client.js";
import { CliError } from "./errors.js";

const API_URL = "http://127.0.0.1:9";
const TOKEN = "rb_sk_client_unit_test_token";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
  isFormData: boolean;
}

let captured: CapturedRequest[] = [];
let nextResponse: (() => Response) | null = null;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-test" },
  });
}

function installFetchStub(): void {
  captured = [];
  nextResponse = null;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (rawHeaders !== undefined && !Array.isArray(rawHeaders)) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    let bodyText: string | null = null;
    let isFormData = false;
    if (init?.body instanceof FormData) {
      isFormData = true;
    } else if (typeof init?.body === "string") {
      bodyText = init.body;
    }
    captured.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      bodyText,
      isFormData,
    });
    if (nextResponse !== null) {
      return nextResponse();
    }
    throw new Error("fetch stub has no queued response");
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client() {
  return createApiClient({ apiUrl: API_URL, token: TOKEN });
}

describe("API client", () => {
  it("sends Bearer auth and parses projects info", async () => {
    installFetchStub();
    nextResponse = () =>
      jsonResponse(200, {
        projectId: "p1",
        projectName: "Shop",
        projectSlug: "shop",
        workspaceId: "w1",
        workspaceName: "Acme",
        timezone: "UTC",
      });
    const info = await client().getProject();
    expect(info.projectSlug).toBe("shop");
    expect(captured).toHaveLength(1);
    const request = captured[0] as CapturedRequest;
    expect(request.url).toBe(`${API_URL}/api/v1/cli/project`);
    expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(request.url).not.toContain(TOKEN);
  });

  it("normalizes server errors with code and requestId", async () => {
    installFetchStub();
    nextResponse = () =>
      jsonResponse(401, {
        code: "AUTH_REQUIRED",
        message: "Authentication required",
        requestId: "req-abc",
      });
    let error: unknown;
    try {
      await client().getProject();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.serverCode).toBe("AUTH_REQUIRED");
    expect(cliError.requestId).toBe("req-abc");
    expect(cliError.status).toBe(401);
    expect(cliError.message).not.toContain(TOKEN);
    expect(cliError.hint).toContain("REPLAYBUG_AUTH_TOKEN");
  });

  it("maps commitSha request field to the commit response field", async () => {
    installFetchStub();
    nextResponse = () =>
      jsonResponse(201, {
        release: {
          id: "r1",
          version: "web@1.0.0",
          commit: "abc123",
          repositoryUrl: null,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        created: true,
      });
    const result = await client().createRelease({
      version: "web@1.0.0",
      commitSha: "abc123",
    });
    expect(result.release.commit).toBe("abc123");
    expect(result.created).toBe(true);
    const request = captured[0] as CapturedRequest;
    expect(request.bodyText).toContain('"commitSha":"abc123"');
  });

  it("omits undefined release metadata from the request body", async () => {
    installFetchStub();
    nextResponse = () =>
      jsonResponse(200, {
        release: {
          id: "r1",
          version: "web@1.0.0",
          commit: null,
          repositoryUrl: null,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        created: false,
      });
    await client().createRelease({ version: "web@1.0.0" });
    expect(captured[0]?.bodyText).toBe('{"version":"web@1.0.0"}');
  });

  it("URL-encodes versions and posts preflight manifests", async () => {
    installFetchStub();
    const entries: PreflightEntry[] = [
      {
        artifactPath: "assets/app.js.map",
        artifactType: "source_map",
        contentHash: "a".repeat(64),
        sizeBytes: 12,
      },
    ];
    nextResponse = () =>
      jsonResponse(200, {
        release: { id: "r1", version: "web@1.0.0" },
        results: [{ ...entries[0], verdict: "upload" }],
      });
    const results = await client().checkPreflight("web@1.0.0+build 7", entries);
    expect(results[0]?.verdict).toBe("upload");
    expect(captured[0]?.url).toContain(
      `/api/v1/cli/releases/${encodeURIComponent("web@1.0.0+build 7")}/artifacts/check`,
    );
  });

  it("reports transport failures as API-unavailable without the token", async () => {
    installFetchStub();
    globalThis.fetch = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    let error: unknown;
    try {
      await client().listReleases();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("Cannot reach the API");
    expect(message).toContain(API_URL);
    expect(message).not.toContain(TOKEN);
  });

  it("reports timeouts as timeouts, not stacks", async () => {
    installFetchStub();
    const timeoutClient = createApiClient({
      apiUrl: API_URL,
      token: TOKEN,
      jsonTimeoutMs: 5,
    });
    globalThis.fetch = ((
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const timeout = new DOMException(
            "The operation timed out.",
            "TimeoutError",
          );
          reject(timeout);
        });
      });
    }) as typeof fetch;
    let error: unknown;
    try {
      await timeoutClient.listReleases();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("timed out");
  });

  it("rejects unexpected response shapes without leaking the token", async () => {
    installFetchStub();
    nextResponse = () => jsonResponse(200, { releases: "nope" });
    let error: unknown;
    try {
      await client().listReleases();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).not.toContain(TOKEN);
  });
});
