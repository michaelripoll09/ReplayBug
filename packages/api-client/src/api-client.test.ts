import { describe, expect, it } from "vitest";
import { createApiClient } from "./index.js";

describe("createApiClient foundation stub", () => {
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
