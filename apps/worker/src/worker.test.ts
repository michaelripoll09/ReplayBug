import { describe, expect, it } from "vitest";
import { loadWorkerConfigFromEnv } from "./config.js";
import { listJobDefinitions } from "./jobs/index.js";

describe("loadWorkerConfigFromEnv", () => {
  it("loads defaults with only the database URL set", () => {
    const config = loadWorkerConfigFromEnv({
      REPLAYBUG_DATABASE_URL: "postgres://localhost:5432/replaybug",
    });
    expect(config.environment).toBe("development");
    expect(config.bossSchema).toBe("pgboss");
  });

  it("fails fast with a readable message when the database URL is missing", () => {
    expect(() => loadWorkerConfigFromEnv({})).toThrow(
      /Invalid worker configuration/,
    );
  });
});

describe("job registry stub", () => {
  it("starts empty with no functional jobs yet", () => {
    expect(listJobDefinitions()).toEqual([]);
  });
});
