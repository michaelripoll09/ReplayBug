import pino, { type Logger, type LoggerOptions } from "pino";

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
  destination?: pino.DestinationStream;
}

function resolveLevel(explicitLevel?: string): string {
  if (explicitLevel !== undefined && explicitLevel !== "") {
    return explicitLevel;
  }
  const fromEnv = process.env["LOG_LEVEL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return process.env["NODE_ENV"] === "production" ? "info" : "debug";
}

function shouldPrettyPrint(explicitPretty?: boolean): boolean {
  if (explicitPretty !== undefined) {
    return explicitPretty;
  }
  // Human-readable output is a development-only convenience. Production and
  // test both use JSON: production for log aggregation, test so unit runs
  // stay deterministic and never spawn pretty-print worker threads.
  return (
    process.env["NODE_ENV"] !== "production" &&
    process.env["NODE_ENV"] !== "test"
  );
}

/**
 * Create a service-scoped Pino logger.
 *
 * Production output is JSON. Development output is human-readable via
 * pino-pretty. Sensitive request material (authorization headers, cookies,
 * request/response bodies) is redacted by default and must never be added
 * back by callers. Request bodies and secret fields are never logged by this
 * helper itself.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const level = resolveLevel(options.level);
  const pretty = shouldPrettyPrint(options.pretty);

  const baseOptions: LoggerOptions = {
    level,
    base: { service: options.service },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['set-cookie']",
        "res.headers['set-cookie']",
        "req.body",
        "res.body",
        "*.password",
        "*.secret",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  };

  if (options.destination !== undefined) {
    return pino(baseOptions, options.destination);
  }

  if (!pretty) {
    return pino(baseOptions);
  }

  return pino({
    ...baseOptions,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, singleLine: false },
    },
  });
}

export type { Logger };
