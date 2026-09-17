import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  createReplayBugApiClient,
  normalizeApiError,
  validationDetails,
} from "./index.js";

describe("createApiClient (legacy alias)", () => {
  it("keeps the configured base URL", () => {
    expect(createApiClient({ baseUrl: "http://localhost:4001" }).baseUrl).toBe(
      "http://localhost:4001",
    );
  });

  it("strips trailing slashes for stable URL joining", () => {
    expect(
      createApiClient({ baseUrl: "http://localhost:4001///" }).baseUrl,
    ).toBe("http://localhost:4001");
  });

  it("rejects an empty base URL", () => {
    expect(() => createApiClient({ baseUrl: "" })).toThrow(/baseUrl/);
  });
});

describe("createReplayBugApiClient", () => {
  it("normalizes baseUrl (trailing slashes) and rejects empty", () => {
    expect(
      createReplayBugApiClient({ baseUrl: "http://localhost:4001///" }).baseUrl,
    ).toBe("http://localhost:4001");
    expect(() => createReplayBugApiClient({ baseUrl: "///" })).toThrow(
      /baseUrl/,
    );
  });

  it("sends credentials:include by default so session cookies flow", async () => {
    const seen: Request[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const req = input instanceof Request ? input : new Request(String(input));
      seen.push(req);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const api = createReplayBugApiClient({
      baseUrl: "http://localhost:4001",
      fetch: fakeFetch,
    });
    const result = await api.client.GET("/api/v1/workspaces", {});
    expect(result.response.status).toBe(200);
    expect(seen.length).toBe(1);
    // openapi-fetch forwards credentials from client options onto the Request.
    expect(seen[0]?.credentials).toBe("include");
  });

  it("unwraps success data", async () => {
    const api = createReplayBugApiClient({ baseUrl: "http://localhost:4001" });
    const ok = await api.unwrap({
      data: { id: "1" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    expect(ok).toEqual({ id: "1" });
  });

  it("preserves the backend envelope {code,message,requestId,details}", async () => {
    const api = createReplayBugApiClient({ baseUrl: "http://localhost:4001" });
    const envelope = {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      requestId: "req-123",
      details: [{ path: "name", message: "Required" }],
    };
    const failure = api.unwrap({
      data: undefined,
      error: envelope,
      response: new Response(null, { status: 400 }),
    });
    await expect(failure).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      requestId: "req-123",
    });
    try {
      await failure.catch((e: unknown) => {
        throw e;
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.details).toEqual(envelope.details);
      expect(validationDetails(apiError)).toEqual([
        { path: "name", message: "Required" },
      ]);
    }
  });

  it("falls back to a safe generic when the body is not an envelope", () => {
    const error = normalizeApiError({ status: 500, body: "<html>oops</html>" });
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toBe("An unexpected error occurred");
    expect(error.requestId).toBe("unknown");
    expect(JSON.stringify(error.toBody())).not.toMatch(/oops/);
  });

  it("maps 401/403/404/409 without leaking internals", () => {
    expect(normalizeApiError({ status: 401 }).code).toBe("AUTH_REQUIRED");
    expect(normalizeApiError({ status: 403 }).code).toBe("FORBIDDEN");
    expect(normalizeApiError({ status: 404 }).code).toBe("NOT_FOUND");
    expect(normalizeApiError({ status: 409 }).code).toBe("CONFLICT");
  });

  it("honors an injected fetch implementation", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ status: "ok", service: "api" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const api = createReplayBugApiClient({
      baseUrl: "http://localhost:4001",
      fetch: mockFetch,
    });
    const { data, error } = await api.client.GET("/health/live", {});
    expect(error).toBeUndefined();
    expect(data).toMatchObject({ status: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
