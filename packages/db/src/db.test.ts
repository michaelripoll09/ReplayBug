import { describe, expect, it } from "vitest";
import { checkDbHealth, loadDbConfigFromEnv } from "./index.js";

describe("loadDbConfigFromEnv", () => {
  it("loads a valid database URL", () => {
    const config = loadDbConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    });
    expect(config.databaseUrl).toBe("postgres://localhost:5432/replaybug");
    expect(config.maxConnections).toBe(10);
  });

  it("fails fast with a readable message when the URL is missing", () => {
    expect(() => loadDbConfigFromEnv({})).toThrow(
      /Invalid database configuration/,
    );
  });

  it("rejects an out-of-range connection pool size", () => {
    expect(() =>
      loadDbConfigFromEnv({
        REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
        REPLAYBUG_DB_MAX_CONNECTIONS: "0",
      }),
    ).toThrow(/Invalid database configuration/);
  });
});

describe("checkDbHealth", () => {
  it("returns true when SELECT 1 succeeds", async () => {
    const ok = await checkDbHealth({
      query: async () => ({ rows: [{ "?column?": 1 }] }),
    });
    expect(ok).toBe(true);
  });

  it("returns false when the query throws", async () => {
    const ok = await checkDbHealth({
      query: async () => {
        throw new Error("connection refused");
      },
    });
    expect(ok).toBe(false);
  });

  it("returns false on timeout instead of hanging", async () => {
    const ok = await checkDbHealth(
      {
        query: () => new Promise(() => {}),
      },
      20,
    );
    expect(ok).toBe(false);
  });
});
