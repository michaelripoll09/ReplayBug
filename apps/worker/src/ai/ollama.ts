import {
  aiAnalysisOutputSchema,
  type AiAnalysisOutput,
} from "@replaybug/contracts";
import type { OllamaCapability } from "../config.js";
import { buildAiAnalysisPrompt, aiAnalysisOutputJsonSchema } from "./prompt.js";
import type {
  AiAnalysisProvider,
  AiAnalysisProviderInput,
} from "./provider.js";

const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
// Allow room for the largest valid schema output (~72 k chars plus JSON escaping)
// while staying well under the bounded HTTP body size.
const MAX_MODEL_CONTENT_CHARS = 200_000;

export type ModelAnalysisErrorCode =
  | "MODEL_DISABLED"
  | "MODEL_MISCONFIGURED"
  | "MODEL_CONFIG_INVALID"
  | "MODEL_TIMEOUT"
  | "MODEL_CONNECTION_FAILED"
  | "MODEL_HTTP_TRANSIENT"
  | "MODEL_HTTP_ERROR"
  | "MODEL_ENVELOPE_INVALID"
  | "MODEL_RESPONSE_INVALID";

export class ModelAnalysisError extends Error {
  constructor(
    readonly code: ModelAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelAnalysisError";
  }
}

interface OllamaProviderOptions {
  fetch?: typeof fetch;
}

function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/chat`;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        await reader.cancel();
        throw new ModelAnalysisError(
          "MODEL_ENVELOPE_INVALID",
          "Model response exceeded the supported size limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseModelContent(body: string): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ModelAnalysisError(
      "MODEL_ENVELOPE_INVALID",
      "Model response envelope is invalid.",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelAnalysisError(
      "MODEL_ENVELOPE_INVALID",
      "Model response envelope is unsupported.",
    );
  }
  const envelope = value as Record<string, unknown>;
  const message = envelope["message"];
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message) ||
    Object.getPrototypeOf(message) !== Object.prototype
  ) {
    throw new ModelAnalysisError(
      "MODEL_ENVELOPE_INVALID",
      "Model response envelope is unsupported.",
    );
  }
  const messageRecord = message as Record<string, unknown>;
  const content = messageRecord["content"];
  if (
    !Object.hasOwn(messageRecord, "role") ||
    !Object.hasOwn(messageRecord, "content") ||
    messageRecord["role"] !== "assistant" ||
    typeof content !== "string" ||
    content.length > MAX_MODEL_CONTENT_CHARS
  ) {
    throw new ModelAnalysisError(
      "MODEL_ENVELOPE_INVALID",
      "Model response envelope is unsupported.",
    );
  }
  return content;
}

function validateOutput(
  content: string,
  allowedRefs: readonly string[],
): AiAnalysisOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelAnalysisError(
      "MODEL_RESPONSE_INVALID",
      "Model returned invalid structured output.",
    );
  }
  const output = aiAnalysisOutputSchema.safeParse(parsed);
  if (!output.success) {
    throw new ModelAnalysisError(
      "MODEL_RESPONSE_INVALID",
      "Model returned invalid structured output.",
    );
  }
  const allowed = new Set(allowedRefs);
  if (output.data.evidence.some((evidence) => !allowed.has(evidence.ref))) {
    throw new ModelAnalysisError(
      "MODEL_RESPONSE_INVALID",
      "Model referenced unavailable evidence.",
    );
  }
  return output.data;
}

function isRetryableStructuredError(
  error: unknown,
): error is ModelAnalysisError {
  return (
    error instanceof ModelAnalysisError &&
    error.code === "MODEL_RESPONSE_INVALID"
  );
}

class OllamaProvider implements AiAnalysisProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: typeof fetch,
  ) {}

  async analyze(input: AiAnalysisProviderInput): Promise<AiAnalysisOutput> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const content = await this.request(input.evidenceJson, attempt === 1);
        return validateOutput(content, input.allowedRefs);
      } catch (error) {
        if (attempt === 0 && isRetryableStructuredError(error)) continue;
        if (error instanceof ModelAnalysisError) {
          if (isRetryableStructuredError(error)) {
            throw new ModelAnalysisError(
              "MODEL_RESPONSE_INVALID",
              "Model did not return valid structured output.",
            );
          }
          throw error;
        }
        throw new ModelAnalysisError(
          "MODEL_CONNECTION_FAILED",
          "Model connection failed.",
        );
      }
    }
    throw new ModelAnalysisError(
      "MODEL_RESPONSE_INVALID",
      "Model did not return valid structured output.",
    );
  }

  private async request(evidenceJson: string, retry: boolean): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(chatEndpoint(this.baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "system",
                content: buildAiAnalysisPrompt(evidenceJson, retry).system,
              },
              {
                role: "user",
                content: buildAiAnalysisPrompt(evidenceJson, retry).user,
              },
            ],
            stream: false,
            format: aiAnalysisOutputJsonSchema,
            options: { temperature: 0 },
          }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw new ModelAnalysisError(
            "MODEL_TIMEOUT",
            "Model request timed out.",
          );
        }
        throw new ModelAnalysisError(
          "MODEL_CONNECTION_FAILED",
          "Model connection failed.",
        );
      }
      if (!response.ok) {
        if (
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          throw new ModelAnalysisError(
            "MODEL_HTTP_TRANSIENT",
            "Model service is temporarily unavailable.",
          );
        }
        throw new ModelAnalysisError(
          "MODEL_HTTP_ERROR",
          "Model service rejected the request.",
        );
      }
      return parseModelContent(await readBoundedBody(response));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createOllamaProvider(
  capability: OllamaCapability,
  options: OllamaProviderOptions = {},
): AiAnalysisProvider {
  if (capability.state === "disabled") {
    throw new ModelAnalysisError("MODEL_DISABLED", "AI analysis is disabled.");
  }
  if (capability.state === "misconfigured") {
    throw new ModelAnalysisError(
      "MODEL_MISCONFIGURED",
      "AI analysis is misconfigured.",
    );
  }
  if (
    typeof options.fetch !== "function" &&
    typeof globalThis.fetch !== "function"
  ) {
    throw new ModelAnalysisError(
      "MODEL_CONFIG_INVALID",
      "No supported fetch implementation is available.",
    );
  }
  return new OllamaProvider(
    capability.baseUrl,
    capability.model,
    capability.timeoutMs,
    options.fetch ?? globalThis.fetch,
  );
}
