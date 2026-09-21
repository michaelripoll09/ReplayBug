import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

/**
 * Ephemeral, protocol-compatible mock Ollama server for E2E.
 *
 * It implements exactly `POST /api/chat` and nothing else: the real Ollama
 * native contract the worker adapter speaks (`model`, `messages`,
 * `stream: false`, JSON Schema in `format`, deterministic
 * `options.temperature: 0`, generated text in `message.content`). There is
 * no model, no download and no network access: every response is
 * synthesized locally on an ephemeral loopback port (`listen(0)`), one
 * server per spec file, closed in teardown so no port or process leaks.
 *
 * Every request is captured **including the full JSON body**, so a spec can
 * assert (a) protocol conformance and (b) the exact outbound evidence
 * whitelist plus its privacy exclusions without reading worker internals.
 *
 * Modes drive the failure taxonomy deterministically: a valid structured
 * response, invalid content, an HTTP failure, a delayed response, or an
 * abrupt connection close.
 */

/** Behaviour of the next `POST /api/chat` requests until the mode changes. */
export type MockOllamaMode =
  | "valid"
  | "malformed-json"
  | "wrong-schema"
  | "unknown-ref"
  | "http-500"
  | "http-429"
  | "delayed"
  | "connection-close";

export interface MockOllamaChatMessage {
  role: string;
  content: string;
}

export interface MockOllamaChatBody {
  model: string;
  messages: MockOllamaChatMessage[];
  stream: boolean;
  format: unknown;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Sanitized evidence bundle the worker embeds in the prompt. */
export interface MockOllamaEvidenceBundle {
  issue: {
    message: { ref: string; text: string };
    type: string;
    severity: string;
    exceptionType: string | null;
  };
  stack: Array<{
    ref: string;
    source: string;
    name: string | null;
    line: number;
    column: number;
  }>;
  timeline: Array<{
    ref: string;
    occurredAt: string;
    kind: string;
    message: string;
  }>;
  network: Array<{
    ref: string;
    occurredAt: string;
    method: string;
    path: string;
    status: number;
  }>;
  environment: string;
  release: { ref: string; value: string } | null;
  timestamps: { occurredAt: string; receivedAt: string | null };
}

export interface MockOllamaRequest {
  /** HTTP method as received (protocol assertions read this). */
  method: string;
  /** Path without query string. */
  path: string;
  contentType: string;
  /** Lowercase header name -> value (joined when repeated). */
  headers: Record<string, string>;
  /** Parsed JSON body, or null when the body is not valid JSON. */
  body: unknown;
  /** Exact bytes received, decoded as UTF-8. */
  rawBody: string;
  /** Mode that served this request. */
  mode: MockOllamaMode;
  /** Status written back, or null when the connection was destroyed. */
  status: number | null;
  receivedAt: number;
}

export interface MockOllamaOptions {
  mode?: MockOllamaMode;
  /** Delay used by `delayed` mode (default 2_000 ms). */
  delayMs?: number;
  /** Model name echoed in responses (default `e2e-mock-ollama`). */
  model?: string;
  /**
   * Builds the `message.content` string for `valid`, `delayed` and
   * `unknown-ref` modes. Receives the extracted evidence bundle (null when
   * the request carries no recognizable evidence) and the parsed body.
   */
  contentBuilder?: (
    evidence: MockOllamaEvidenceBundle | null,
    body: MockOllamaChatBody | null,
  ) => string;
}

export const EVIDENCE_BEGIN = "<<<UNTRUSTED_EVIDENCE_JSON>>>";
export const EVIDENCE_END = "<<<END_UNTRUSTED_EVIDENCE_JSON>>>";

/** Leak sentinels: they must never reach the UI or the database. */
export const PROVIDER_SENTINEL = "RAW_PROVIDER_SENTINEL_9f31";

export const MALFORMED_CONTENT = `${PROVIDER_SENTINEL} {"summary": "truncated`;

export const WRONG_SCHEMA_CONTENT = JSON.stringify({
  summary: `${PROVIDER_SENTINEL} wrong schema`,
  suspectedCause: 42,
  evidence: "not-an-array",
});

const DEFAULT_MODEL = "e2e-mock-ollama";
const DEFAULT_DELAY_MS = 2_000;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asChatMessage(value: unknown): MockOllamaChatMessage | null {
  if (!isRecord(value)) return null;
  const role = asString(value["role"]);
  const content = asString(value["content"]);
  if (role === null || content === null) return null;
  return { role, content };
}

/** Narrowing guard: no `as` cast is needed to read a captured body. */
export function asChatBody(value: unknown): MockOllamaChatBody | null {
  if (!isRecord(value)) return null;
  const model = asString(value["model"]);
  const stream = value["stream"];
  const messages = value["messages"];
  if (model === null || typeof stream !== "boolean") return null;
  if (!Array.isArray(messages)) return null;
  const parsed: MockOllamaChatMessage[] = [];
  for (const message of messages) {
    const entry = asChatMessage(message);
    if (entry === null) return null;
    parsed.push(entry);
  }
  return {
    ...value,
    model,
    messages: parsed,
    stream,
    format: value["format"],
  };
}

type EvidenceStack = MockOllamaEvidenceBundle["stack"];
type EvidenceTimeline = MockOllamaEvidenceBundle["timeline"];
type EvidenceNetwork = MockOllamaEvidenceBundle["network"];

function asEvidenceStack(value: unknown): EvidenceStack | null {
  if (!Array.isArray(value)) return null;
  const stack: EvidenceStack = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const ref = asString(item["ref"]);
    const source = asString(item["source"]);
    if (ref === null || source === null) return null;
    stack.push({
      ref,
      source,
      name: asString(item["name"]),
      line: typeof item["line"] === "number" ? item["line"] : 0,
      column: typeof item["column"] === "number" ? item["column"] : 0,
    });
  }
  return stack;
}

function asEvidenceTimeline(value: unknown): EvidenceTimeline | null {
  if (!Array.isArray(value)) return null;
  const timeline: EvidenceTimeline = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const ref = asString(item["ref"]);
    const occurredAt = asString(item["occurredAt"]);
    const kind = asString(item["kind"]);
    const message = asString(item["message"]);
    if (
      ref === null ||
      occurredAt === null ||
      kind === null ||
      message === null
    ) {
      return null;
    }
    timeline.push({ ref, occurredAt, kind, message });
  }
  return timeline;
}

function asEvidenceNetwork(value: unknown): EvidenceNetwork | null {
  if (!Array.isArray(value)) return null;
  const network: EvidenceNetwork = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const ref = asString(item["ref"]);
    const occurredAt = asString(item["occurredAt"]);
    const method = asString(item["method"]);
    const path = asString(item["path"]);
    const status = item["status"];
    if (
      ref === null ||
      occurredAt === null ||
      method === null ||
      path === null ||
      typeof status !== "number"
    ) {
      return null;
    }
    network.push({ ref, occurredAt, method, path, status });
  }
  return network;
}

function asEvidenceBundle(value: unknown): MockOllamaEvidenceBundle | null {
  if (!isRecord(value)) return null;
  const issue = value["issue"];
  const stack = asEvidenceStack(value["stack"]);
  const timeline = asEvidenceTimeline(value["timeline"]);
  const network = asEvidenceNetwork(value["network"]);
  const environment = asString(value["environment"]);
  if (!isRecord(issue) || stack === null || timeline === null) return null;
  if (network === null || environment === null) return null;
  const message = issue["message"];
  if (!isRecord(message)) return null;
  const messageRef = asString(message["ref"]);
  const messageText = asString(message["text"]);
  if (messageRef === null || messageText === null) return null;
  const release = value["release"];
  let releaseEntry: MockOllamaEvidenceBundle["release"] = null;
  if (release !== null && release !== undefined) {
    if (!isRecord(release)) return null;
    const releaseValue = asString(release["value"]);
    if (releaseValue === null) return null;
    releaseEntry = {
      ref: asString(release["ref"]) ?? "release:current",
      value: releaseValue,
    };
  }
  const timestamps = value["timestamps"];
  return {
    issue: {
      message: { ref: messageRef, text: messageText },
      type: asString(issue["type"]) ?? "",
      severity: asString(issue["severity"]) ?? "",
      exceptionType: asString(issue["exceptionType"]),
    },
    stack,
    timeline,
    network,
    environment,
    release: releaseEntry,
    timestamps: {
      occurredAt: isRecord(timestamps)
        ? (asString(timestamps["occurredAt"]) ?? "")
        : "",
      receivedAt: isRecord(timestamps)
        ? asString(timestamps["receivedAt"])
        : null,
    },
  };
}

/**
 * Extracts the sanitized evidence bundle the worker embeds between the
 * untrusted-evidence markers of the user message.
 */
export function extractEvidenceBundle(
  body: MockOllamaChatBody | null,
): MockOllamaEvidenceBundle | null {
  if (body === null) return null;
  for (const message of body.messages) {
    const start = message.content.indexOf(EVIDENCE_BEGIN);
    if (start === -1) continue;
    const end = message.content.indexOf(EVIDENCE_END, start);
    if (end === -1) continue;
    const json = message.content.slice(start + EVIDENCE_BEGIN.length, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    return asEvidenceBundle(parsed);
  }
  return null;
}

/** Minimal synthetic valid structured output, derived from real refs. */
export function defaultValidContent(
  evidence: MockOllamaEvidenceBundle | null,
): string {
  const stackRef = evidence?.stack[0]?.ref;
  const timelineRef = evidence?.timeline[0]?.ref;
  return JSON.stringify({
    summary: "Mock summary generated from the bounded evidence bundle.",
    suspectedCause:
      "Mock suspected cause derived from the first captured stack frame.",
    evidence: [
      { ref: "issue:message", reason: "Normalized issue message." },
      ...(stackRef === undefined
        ? []
        : [{ ref: stackRef, reason: "Top captured stack frame." }]),
      ...(timelineRef === undefined
        ? []
        : [{ ref: timelineRef, reason: "Closest preceding timeline entry." }]),
    ],
    reproductionSteps: ["Open the reported page.", "Repeat the capture."],
    limitations: ["Mock output; no model was executed."],
  });
}

/** Replaces every evidence ref of a valid payload with unknown refs. */
function unknownRefContent(valid: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valid);
  } catch {
    return valid;
  }
  if (!isRecord(parsed)) return valid;
  return JSON.stringify({
    ...parsed,
    evidence: [
      { ref: "stack:999", reason: "Unknown stack frame reference." },
      {
        ref: "evidence:not-a-real-ref",
        reason: "Unknown evidence reference.",
      },
    ],
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      total += buffer.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        request.destroy();
        break;
      }
      chunks.push(buffer);
    }
  } catch {
    return Buffer.concat(chunks).toString("utf8");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(raw: string): unknown {
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** One mock Ollama instance bound to an ephemeral loopback port. */
export class MockOllamaServer {
  private readonly captured: MockOllamaRequest[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private modeState: MockOllamaMode;
  private delayMsState: number;
  private readonly modelName: string;
  private readonly contentBuilder: MockOllamaOptions["contentBuilder"];

  private constructor(
    private readonly server: Server,
    options: MockOllamaOptions,
  ) {
    this.modeState = options.mode ?? "valid";
    this.delayMsState = options.delayMs ?? DEFAULT_DELAY_MS;
    this.modelName = options.model ?? DEFAULT_MODEL;
    this.contentBuilder = options.contentBuilder;
  }

  /** Starts the server on an ephemeral 127.0.0.1 port. */
  static async start(
    options: MockOllamaOptions = {},
  ): Promise<MockOllamaServer> {
    let instance: MockOllamaServer | null = null;
    const server = createServer((request, response) => {
      instance?.handle(request, response);
    });
    instance = new MockOllamaServer(server, options);
    server.on("connection", (socket) => {
      instance?.sockets.add(socket);
      socket.on("close", () => instance?.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return instance;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("mock Ollama server is not listening");
    }
    return address.port;
  }

  /** Base URL without a trailing slash, for `REPLAYBUG_OLLAMA_URL`. */
  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  get mode(): MockOllamaMode {
    return this.modeState;
  }

  setMode(mode: MockOllamaMode, options: { delayMs?: number } = {}): void {
    this.modeState = mode;
    if (options.delayMs !== undefined) {
      this.delayMsState = options.delayMs;
    }
  }

  /** Every captured request, oldest first. */
  get requests(): readonly MockOllamaRequest[] {
    return this.captured;
  }

  get requestCount(): number {
    return this.captured.length;
  }

  /** Drops the capture log; assertions scope themselves with this. */
  clearRequests(): void {
    this.captured.length = 0;
  }

  requestsInMode(mode: MockOllamaMode): MockOllamaRequest[] {
    return this.captured.filter((entry) => entry.mode === mode);
  }

  /** Closes the listener and destroys every socket/timer (no leaks). */
  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    const closed = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.server.closeAllConnections();
    this.sockets.clear();
    await closed;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const mode = this.modeState;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers[name] = value;
      } else if (Array.isArray(value)) {
        headers[name] = value.join(", ");
      }
    }
    const rawUrl = request.url ?? "";
    const path = rawUrl.split("?")[0] ?? "";
    const contentType = headers["content-type"] ?? "";
    const method = request.method ?? "";
    // A client may abort a delayed response or a close-mode request:
    // never let a socket error reach the test runner.
    request.on("error", () => undefined);
    response.on("error", () => undefined);

    void readBody(request)
      .then((rawBody) => {
        const captured: MockOllamaRequest = {
          method,
          path,
          contentType,
          headers,
          body: parseJsonBody(rawBody),
          rawBody,
          mode,
          status: null,
          receivedAt: Date.now(),
        };
        this.captured.push(captured);
        this.serve(captured, request, response);
      })
      .catch(() => {
        request.socket.destroy();
      });
  }

  private serve(
    captured: MockOllamaRequest,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (captured.mode === "connection-close") {
      request.socket.destroy();
      return;
    }
    if (captured.method !== "POST") {
      this.respondJson(captured, response, 405, {
        error: "method-not-allowed",
      });
      return;
    }
    if (captured.path !== "/api/chat") {
      this.respondJson(captured, response, 404, { error: "not-found" });
      return;
    }
    if (!captured.contentType.toLowerCase().includes("application/json")) {
      this.respondJson(captured, response, 415, {
        error: "unsupported-media-type",
      });
      return;
    }
    const chat = asChatBody(captured.body);
    switch (captured.mode) {
      case "http-500":
        this.respondJson(captured, response, 500, {
          error: "mock provider failure",
        });
        return;
      case "http-429":
        this.respondJson(captured, response, 429, {
          error: "mock provider busy",
        });
        return;
      case "malformed-json":
        this.respondEnvelope(captured, response, MALFORMED_CONTENT);
        return;
      case "wrong-schema":
        this.respondEnvelope(captured, response, WRONG_SCHEMA_CONTENT);
        return;
      case "unknown-ref":
        this.respondEnvelope(
          captured,
          response,
          unknownRefContent(this.buildContent(chat)),
        );
        return;
      case "delayed": {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.respondEnvelope(captured, response, this.buildContent(chat));
        }, this.delayMsState);
        this.timers.add(timer);
        return;
      }
      case "valid":
        this.respondEnvelope(captured, response, this.buildContent(chat));
        return;
    }
  }

  private buildContent(chat: MockOllamaChatBody | null): string {
    const evidence = extractEvidenceBundle(chat);
    if (this.contentBuilder !== undefined) {
      return this.contentBuilder(evidence, chat);
    }
    return defaultValidContent(evidence);
  }

  /** Wraps generated text in the real `/api/chat` response envelope. */
  private respondEnvelope(
    captured: MockOllamaRequest,
    response: ServerResponse,
    content: string,
  ): void {
    const body = JSON.stringify({
      model: this.modelName,
      created_at: new Date(0).toISOString(),
      done: true,
      done_reason: "stop",
      message: { role: "assistant", content },
    });
    this.respondBody(captured, response, 200, body);
  }

  private respondJson(
    captured: MockOllamaRequest,
    response: ServerResponse,
    status: number,
    payload: Record<string, unknown>,
  ): void {
    this.respondBody(captured, response, status, JSON.stringify(payload));
  }

  private respondBody(
    captured: MockOllamaRequest,
    response: ServerResponse,
    status: number,
    body: string,
  ): void {
    captured.status = status;
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}
