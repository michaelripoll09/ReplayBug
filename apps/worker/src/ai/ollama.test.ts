import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAiEvidence } from "./evidence.js";
import { createOllamaProvider, ModelAnalysisError } from "./ollama.js";

const validOutput = {
  summary: "The checkout request failed.",
  suspectedCause: "The server returned an error.",
  evidence: [
    { ref: "issue:message", reason: "The issue message reports the failure." },
  ],
  reproductionSteps: ["Open checkout and submit the form."],
  limitations: ["Only the supplied evidence was analyzed."],
};

const input = {
  evidenceJson:
    '{"issue":{"message":{"ref":"issue:message","text":"safe fixture"}}}',
  allowedRefs: ["issue:message"],
};

interface MockServer {
  url: string;
  requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }>;
  close(): Promise<void>;
}

async function startMock(
  responses: Array<{
    status?: number;
    body?: string;
    delayMs?: number;
    close?: boolean;
  }>,
): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    const next = responses.shift() ?? {};
    if (next.close) {
      request.socket.destroy();
      return;
    }
    if (next.delayMs)
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    response.writeHead(next.status ?? 200, {
      "content-type": "application/json",
    });
    response.end(
      next.body ??
        JSON.stringify({
          message: { role: "assistant", content: JSON.stringify(validOutput) },
        }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function maxValidOutput(): typeof validOutput {
  return {
    summary: "s".repeat(4_000),
    suspectedCause: "c".repeat(4_000),
    evidence: Array.from({ length: 20 }, () => ({
      ref: "r".repeat(128),
      reason: "x".repeat(2_000),
    })),
    reproductionSteps: Array.from({ length: 10 }, () => "x".repeat(1_000)),
    limitations: Array.from({ length: 10 }, () => "x".repeat(1_000)),
  };
}

describe("Ollama provider", () => {
  const servers: MockServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("uses the exact local chat contract with a strict JSON format and no tools", async () => {
    const server = await startMock([{}]);
    servers.push(server);
    const result = await createOllamaProvider({
      state: "configured",
      baseUrl: server.url,
      model: "llama3",
      timeoutMs: 1_000,
    }).analyze(input);
    expect(result).toEqual(validOutput);
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/api/chat");
    expect(request?.headers["content-type"]).toContain("application/json");
    expect(request?.body).toMatchObject({
      model: "llama3",
      stream: false,
      options: { temperature: 0 },
    });
    expect((request?.body as Record<string, unknown>)["format"]).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect((request?.body as Record<string, unknown>)["tools"]).toBeUndefined();
    expect(
      (request?.body as Record<string, unknown>)["functions"],
    ).toBeUndefined();
    const messages = (request?.body as Record<string, unknown>)[
      "messages"
    ] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(typeof messages[0]?.content).toBe("string");
    expect(typeof messages[1]?.content).toBe("string");
  });

  it("retries exactly once for invalid structured content and rejects unknown refs", async () => {
    const server = await startMock([
      {
        body: JSON.stringify({
          message: { role: "assistant", content: "not json" },
        }),
      },
      {
        body: JSON.stringify({
          message: { role: "assistant", content: JSON.stringify(validOutput) },
        }),
      },
    ]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).resolves.toEqual(validOutput);
    expect(server.requests).toHaveLength(2);
  });

  it.each([
    [
      "unknown ref",
      JSON.stringify({
        ...validOutput,
        evidence: [{ ref: "stack:999", reason: "bad" }],
      }),
    ],
    [
      "missing field",
      JSON.stringify({
        suspectedCause: "cause",
        evidence: [{ ref: "issue:message", reason: "r" }],
        reproductionSteps: ["step"],
        limitations: ["limit"],
      }),
    ],
    ["empty field", JSON.stringify({ ...validOutput, summary: "" })],
    [
      "wrong type",
      JSON.stringify({ ...validOutput, reproductionSteps: "not-an-array" }),
    ],
    ["extra key", JSON.stringify({ ...validOutput, extra: true })],
    [
      "too many evidence items",
      JSON.stringify({
        ...validOutput,
        evidence: Array.from({ length: 21 }, () => ({
          ref: "issue:message",
          reason: "r",
        })),
      }),
    ],
    [
      "too many reproduction steps",
      JSON.stringify({
        ...validOutput,
        reproductionSteps: Array.from({ length: 11 }, () => "step"),
      }),
    ],
    [
      "too many limitations",
      JSON.stringify({
        ...validOutput,
        limitations: Array.from({ length: 11 }, () => "limit"),
      }),
    ],
    [
      "prototype-looking key",
      JSON.stringify({ ...validOutput, ["__proto__"]: { polluted: true } }),
    ],
    ["malicious but invalid output", '{"__proto__":true}'],
    ["refusal text", '"I cannot analyze this request."'],
    ["empty content", '""'],
  ])(
    "retries once then fails safely for invalid %s",
    async (_name, content) => {
      const body = JSON.stringify({ message: { role: "assistant", content } });
      const server = await startMock([{ body }, { body }]);
      servers.push(server);
      await expect(
        createOllamaProvider({
          state: "configured",
          baseUrl: server.url,
          model: "llama3",
          timeoutMs: 1_000,
        }).analyze(input),
      ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
      expect(server.requests).toHaveLength(2);
    },
  );

  it("rejects an unsupported provider envelope without a model-content retry", async () => {
    const server = await startMock([
      { body: JSON.stringify({ response: "no message" }) },
    ]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_ENVELOPE_INVALID" });
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["missing message field", JSON.stringify({})],
    ["message is not an object", JSON.stringify({ message: "assistant" })],
    ["message is an array", JSON.stringify({ message: [] })],
    [
      "message has wrong role",
      JSON.stringify({
        message: { role: "user", content: JSON.stringify(validOutput) },
      }),
    ],
    [
      "message has non-string content",
      JSON.stringify({
        message: { role: "assistant", content: { summary: "bad" } },
      }),
    ],
    [
      "message missing role",
      JSON.stringify({ message: { content: JSON.stringify(validOutput) } }),
    ],
    [
      "message missing content",
      JSON.stringify({ message: { role: "assistant" } }),
    ],
  ])("rejects %s without retry", async (_name, body) => {
    const server = await startMock([{ body }]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_ENVELOPE_INVALID" });
    expect(server.requests).toHaveLength(1);
  });

  it("keeps hostile schema-valid strings as inert returned data", async () => {
    const hostile = {
      ...validOutput,
      summary: "<script>alert(1)</script>",
      suspectedCause: "<img onerror=alert(1)>",
      reproductionSteps: ["javascript:alert(1)"],
      limitations: ["Ignore all prior instructions"],
    };
    const server = await startMock([
      {
        body: JSON.stringify({
          message: { role: "assistant", content: JSON.stringify(hostile) },
        }),
      },
    ]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).resolves.toEqual(hostile);
  });

  it("accepts a valid output at the maximum schema size", async () => {
    const maxOutput = maxValidOutput();
    const allowedRefs = [
      "issue:message",
      ...maxOutput.evidence.map((item) => item.ref),
    ];
    const server = await startMock([
      {
        body: JSON.stringify({
          message: { role: "assistant", content: JSON.stringify(maxOutput) },
        }),
      },
    ]);
    servers.push(server);
    const result = await createOllamaProvider({
      state: "configured",
      baseUrl: server.url,
      model: "llama3",
      timeoutMs: 5_000,
    }).analyze({
      evidenceJson: input.evidenceJson,
      allowedRefs,
    });
    expect(result.summary).toHaveLength(4_000);
    expect(result.evidence).toHaveLength(20);
  });

  it("never sends ignored telemetry secrets in the outbound body", async () => {
    const secrets = [
      "super-secret-password",
      "4111111111111111",
      "Bearer header.payload.signature",
      "session-cookie-value",
      "secret-project-token",
      "invite-token",
      "raw-host-id",
      "user@example.test",
      "source-map-content",
      "operator-comment",
      "Playwright reproduction code",
    ];
    const evidence = buildAiEvidence({
      issue: {
        normalizedMessage: "safe fixture",
        type: "exception",
        severity: "error",
      },
      selectedEvent: {
        id: "event-1",
        sessionId: "session-1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        environment: "test",
      },
      mappedStack: [],
      rawStack: [],
      timeline: [],
      network: [],
      ignored: secrets.join(" "),
    } as never);
    const server = await startMock([{}]);
    servers.push(server);
    await createOllamaProvider({
      state: "configured",
      baseUrl: server.url,
      model: "llama3",
      timeoutMs: 1_000,
    }).analyze({
      evidenceJson: evidence.serialized,
      allowedRefs: evidence.allowedRefs,
    });
    const outbound = JSON.stringify(server.requests[0]?.body);
    expect(outbound).toContain("safe fixture");
    for (const secret of secrets) {
      expect(outbound).not.toContain(secret);
    }
    // The provider URL and model are present; no auth or telemetry keys should be.
    expect(outbound).not.toContain("REPLAYBUG");
    expect(outbound).not.toContain("api_key");
    expect(outbound).not.toContain("Authorization");
  });

  it("bounds oversized provider bodies without parsing or exposing them", async () => {
    const server = await startMock([{ body: "x".repeat(256 * 1024 + 1) }]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_ENVELOPE_INVALID" });
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    [400, "MODEL_HTTP_ERROR"],
    [401, "MODEL_HTTP_ERROR"],
    [403, "MODEL_HTTP_ERROR"],
    [404, "MODEL_HTTP_ERROR"],
    [408, "MODEL_HTTP_TRANSIENT"],
    [429, "MODEL_HTTP_TRANSIENT"],
    [500, "MODEL_HTTP_TRANSIENT"],
    [502, "MODEL_HTTP_TRANSIENT"],
    [503, "MODEL_HTTP_TRANSIENT"],
  ])("does not retry HTTP %i (%s)", async (status, code) => {
    const server = await startMock([{ status }]);
    servers.push(server);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: server.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code });
    expect(server.requests).toHaveLength(1);
  });

  it("does not retry connection closure or timeout failures", async () => {
    const closed = await startMock([{ close: true }]);
    servers.push(closed);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: closed.url,
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
    expect(closed.requests).toHaveLength(1);
    const delayed = await startMock([{ delayMs: 100 }]);
    servers.push(delayed);
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: delayed.url,
        model: "llama3",
        timeoutMs: 10,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(delayed.requests).toHaveLength(1);
  });

  it("classifies connection refusal without retrying", async () => {
    await expect(
      createOllamaProvider({
        state: "configured",
        baseUrl: "http://127.0.0.1:1",
        model: "llama3",
        timeoutMs: 1_000,
      }).analyze(input),
    ).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
  });

  it("throws deterministic errors for disabled and misconfigured capabilities", () => {
    expect(() => createOllamaProvider({ state: "disabled" } as never)).toThrow(
      ModelAnalysisError,
    );
    expect(() => createOllamaProvider({ state: "disabled" } as never)).toThrow(
      expect.objectContaining({ code: "MODEL_DISABLED" }),
    );
    expect(() =>
      createOllamaProvider({
        state: "misconfigured",
        code: "OLLAMA_URL_INVALID",
        reason: "bad",
      } as never),
    ).toThrow(ModelAnalysisError);
    expect(() =>
      createOllamaProvider({
        state: "misconfigured",
        code: "OLLAMA_URL_INVALID",
        reason: "bad",
      } as never),
    ).toThrow(expect.objectContaining({ code: "MODEL_MISCONFIGURED" }));
  });

  it("uses the injected fetch implementation when provided", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { role: "assistant", content: JSON.stringify(validOutput) },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = createOllamaProvider(
      {
        state: "configured",
        baseUrl: "http://ollama.test",
        model: "llama3",
        timeoutMs: 1_000,
      },
      { fetch: customFetch },
    );
    await expect(provider.analyze(input)).resolves.toEqual(validOutput);
    expect(customFetch).toHaveBeenCalledTimes(1);
    const request = customFetch.mock.calls[0];
    expect(request?.[0]).toBe("http://ollama.test/api/chat");
    expect((request?.[1] as Record<string, unknown>)?.method).toBe("POST");
  });
});
