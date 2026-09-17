import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "./index.js";

function captureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback): void {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

describe("createLogger", () => {
  it("binds the service name on every line", () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({
      service: "api",
      pretty: false,
      destination: stream,
    });
    logger.info("hello");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('"service":"api"');
    expect(lines[0]).toContain('"msg":"hello"');
  });

  it("emits JSON in production mode without pretty transport", () => {
    const previousEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const { stream, lines } = captureStream();
      const logger = createLogger({ service: "worker", destination: stream });
      logger.info("production line");
      const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(parsed["service"]).toBe("worker");
      expect(parsed["msg"]).toBe("production line");
    } finally {
      process.env["NODE_ENV"] = previousEnv;
    }
  });

  it("honors an explicit level over environment defaults", () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({
      service: "api",
      level: "warn",
      pretty: false,
      destination: stream,
    });
    expect(logger.level).toBe("warn");
    logger.info("suppressed");
    logger.warn("visible");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("visible");
  });

  it("redacts authorization headers, cookies and secret fields", () => {
    const { stream, lines } = captureStream();
    const logger = createLogger({
      service: "api",
      pretty: false,
      destination: stream,
    });
    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer super-secret-value",
            cookie: "session=abc123",
          },
          body: { password: "hunter2" },
        },
      },
      "request",
    );
    const output = lines.join("\n");
    expect(output).not.toContain("super-secret-value");
    expect(output).not.toContain("session=abc123");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("[REDACTED]");
  });

  it("defaults to JSON output in test environments (no pretty worker)", () => {
    const previousEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "test";
    try {
      const { stream, lines } = captureStream();
      const logger = createLogger({ service: "api", destination: stream });
      logger.info("test line");
      const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(parsed["service"]).toBe("api");
      expect(parsed["msg"]).toBe("test line");
    } finally {
      process.env["NODE_ENV"] = previousEnv;
    }
  });

  it("falls back to a working stdout logger when no destination is given", () => {
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const logger = createLogger({ service: "api", pretty: false });
      expect(() => logger.info("direct")).not.toThrow();
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
