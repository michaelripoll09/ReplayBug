/**
 * RS-07 CLI errors: developer-friendly, redacted, no stack traces by default.
 *
 * Every failure surfaces as a `CliError` carrying a human message, an
 * optional hint, and — for API failures — the server `code`/`requestId`
 * so reports are actionable. The token is never embedded in any message,
 * hint, or debug output: it only ever travels in the `Authorization`
 * header built by the network client.
 */
export interface CliErrorOptions {
  requestId?: string | undefined;
  serverCode?: string | undefined;
  status?: number | undefined;
  hint?: string | undefined;
}

export class CliError extends Error {
  readonly requestId: string | undefined;
  readonly serverCode: string | undefined;
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.requestId = options.requestId;
    this.serverCode = options.serverCode;
    this.status = options.status;
    this.hint = options.hint;
  }
}

/**
 * Render a CLI failure for stderr: `Error: <message>`, the server
 * `requestId` when one was reported, and a `Hint:` line when available.
 * Never includes credentials — callers must never interpolate tokens.
 */
export function formatCliError(error: CliError): string {
  const lines = [`Error: ${error.message}`];
  if (error.requestId !== undefined && error.requestId.length > 0) {
    lines.push(`Request ID: ${error.requestId}`);
  }
  if (error.hint !== undefined && error.hint.length > 0) {
    lines.push(`Hint: ${error.hint}`);
  }
  return lines.join("\n");
}

/** Debug mode prints stacks; it must still never log the token. */
export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["REPLAYBUG_DEBUG"];
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
