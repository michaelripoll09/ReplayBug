import { describe, expect, it } from "vitest";
import { normalizeMessage, normalizePath } from "./normalize.js";

describe("URL-like token normalization (linear scanner)", () => {
  it("keeps golden grouping outputs byte-identical", () => {
    expect(
      normalizeMessage(
        "Failed to fetch https://api.example.com/users/7192381?cacheBust=abc123",
      ),
    ).toBe("Failed to fetch /users/:id");
    expect(normalizeMessage("Cannot load /orders?id=12345")).toBe(
      "Cannot load /orders",
    );
    expect(normalizeMessage("Missing /profile#section-2")).toBe(
      "Missing /profile",
    );
    expect(normalizeMessage("GET /api/users/7192381 failed")).toBe(
      "GET /api/users/:id failed",
    );
    expect(normalizeMessage("Cannot load user 7192381 at /users/7192381")).toBe(
      "Cannot load user :id at /users/:id",
    );
  });

  it("handles scheme URLs, custom schemes and protocol-relative URLs", () => {
    expect(normalizeMessage("see http://h.test/a/7192381 end")).toBe(
      "see /a/:id end",
    );
    expect(normalizeMessage("see https://h.test:8080/a end")).toBe(
      "see /a end",
    );
    expect(normalizeMessage("open custom+scheme://host/a/99001 now")).toBe(
      "open /a/:id now",
    );
    expect(normalizeMessage("load //cdn.test/assets/app.js?v=2 ok")).toBe(
      "load /assets/app.js ok",
    );
  });

  it("keeps query/hash stripping and punctuation restoration", () => {
    expect(normalizeMessage("hit /foo/12345!!!")).toBe("hit /foo/:id!!!");
    expect(normalizeMessage("see (/docs/x), then")).toBe("see (/docs/x), then");
    // Short numbers stay stable; punctuation is restored verbatim.
    expect(normalizeMessage("at /a/1, /b/2.")).toBe("at /a/1, /b/2.");
    expect(normalizeMessage("at /a/71921, /b/88312.")).toBe(
      "at /a/:id, /b/:id.",
    );
  });

  it("ignores malformed schemes and lone slashes", () => {
    // "http:// " tokenizes as "//" -> "/" exactly like the previous
    // regex did (single `/` plus its `/` continuation).
    expect(normalizeMessage("http:// cried")).toBe("http:/ cried");
    expect(normalizeMessage("a slash / alone")).toBe("a slash / alone");
    expect(normalizeMessage("mailto:foo@bar")).toBe("mailto:foo@bar");
    expect(normalizeMessage("Version 1.2.3 crashed")).toBe(
      "Version 1.2.3 crashed",
    );
  });

  it("completes very long hostile inputs quickly", () => {
    const hostileUrl = `GET ${`https://h.test/${"a".repeat(1000)}/`}${"1".repeat(50_000)}?x=${"y".repeat(50_000)} failed`;
    const hostileSlashes = `x ${"/".repeat(100_000)}y end`;
    const hostileScheme = `${"a".repeat(100_000)}://x`;
    for (const input of [hostileUrl, hostileSlashes, hostileScheme]) {
      const started = Date.now();
      const out = normalizeMessage(input);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(typeof out).toBe("string");
    }
  }, 20000);

  it("normalizes paths identically to normalizePath", () => {
    expect(normalizePath("https://api.example.com/api/users/7192381")).toBe(
      "/api/users/:id",
    );
    expect(normalizePath("//cdn.example.com/assets/app.js?v=2")).toBe(
      "/assets/app.js",
    );
  });
});
