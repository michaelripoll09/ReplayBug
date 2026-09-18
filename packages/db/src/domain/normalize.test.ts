import { describe, expect, it } from "vitest";
import {
  NORMALIZED_PLACEHOLDER,
  formatStackFrame,
  normalizeFilename,
  normalizeMessage,
  normalizePath,
  normalizeStackFrame,
  selectTopFrames,
} from "./normalize.js";

describe("normalizeMessage", () => {
  it("replaces UUIDs", () => {
    expect(
      normalizeMessage(
        "Failed to load user 550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("Failed to load user :id");
  });

  it("replaces ISO timestamps", () => {
    expect(normalizeMessage("Timeout after 2026-09-17T12:34:56.789Z")).toBe(
      "Timeout after :timestamp",
    );
    expect(normalizeMessage("Window 2026-09-17 12:34:56 closed")).toBe(
      "Window :timestamp closed",
    );
    expect(normalizeMessage("At 2026-09-17T12:34:56+02:00 boom")).toBe(
      "At :timestamp boom",
    );
  });

  it("replaces long integer IDs", () => {
    expect(normalizeMessage("Cannot load user 7192381")).toBe(
      "Cannot load user :id",
    );
    expect(normalizeMessage("Order 12345 missing")).toBe("Order :id missing");
  });

  it("keeps ordinary short numbers stable", () => {
    expect(normalizeMessage("Request failed with status 500")).toBe(
      "Request failed with status 500",
    );
    expect(normalizeMessage("Listening on port 8080")).toBe(
      "Listening on port 8080",
    );
    expect(normalizeMessage("Version 1.2.3 crashed")).toBe(
      "Version 1.2.3 crashed",
    );
    expect(normalizeMessage("Retry in 1234 ms")).toBe("Retry in 1234 ms");
  });

  it("replaces long hexadecimal IDs", () => {
    expect(normalizeMessage("Row 9f8e7d6c5b4a vanished")).toBe(
      "Row :hex vanished",
    );
  });

  it("does not replace hex-letter-only words without digits", () => {
    expect(normalizeMessage("The deadbeef constant is fine")).toBe(
      "The deadbeef constant is fine",
    );
  });

  it("replaces memory-address-like values", () => {
    expect(normalizeMessage("Segfault at 0x1a2b3c4d5e")).toBe(
      "Segfault at :addr",
    );
  });

  it("removes query strings from embedded URLs", () => {
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
  });

  it("normalizes variable numeric route segments consistently", () => {
    const first = normalizeMessage("GET /api/users/7192381 failed");
    const second = normalizeMessage("GET /api/users/8831921 failed");
    expect(first).toBe("GET /api/users/:id failed");
    expect(first).toBe(second);
  });

  it("normalizes the master-spec example", () => {
    expect(normalizeMessage("Cannot load user 7192381 at /users/7192381")).toBe(
      "Cannot load user :id at /users/:id",
    );
  });

  it("replaces long opaque tokens", () => {
    expect(normalizeMessage("Token aB3xK9mP2qRs7tUv9012 rejected")).toBe(
      "Token :token rejected",
    );
    expect(normalizeMessage("Word aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa stays")).toBe(
      "Word aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa stays",
    );
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeMessage("  too   many\n\nspaces  ")).toBe(
      "too many spaces",
    );
  });

  it("is idempotent", () => {
    const once = normalizeMessage(
      "Cannot load user 7192381 at /users/7192381?x=1",
    );
    expect(normalizeMessage(once)).toBe(once);
  });
});

describe("normalizePath", () => {
  it("drops origin, query string and fragment", () => {
    expect(
      normalizePath("https://api.example.com/api/users/7192381?token=abc#top"),
    ).toBe("/api/users/:id");
  });

  it("handles protocol-relative URLs", () => {
    expect(normalizePath("//cdn.example.com/assets/app.js?v=2")).toBe(
      "/assets/app.js",
    );
  });

  it("normalizes UUID and hex segments", () => {
    expect(normalizePath("/orgs/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/orgs/:id",
    );
    expect(normalizePath("/rows/9f8e7d6c5b4a")).toBe("/rows/:hex");
  });

  it("normalizes content hashes embedded in file names", () => {
    expect(normalizePath("/assets/index-Bx3K9mPQ.js")).toBe(
      "/assets/index-:hash.js",
    );
    expect(normalizePath("/assets/main.4f3a2b1c.js")).toBe(
      "/assets/main.:hash.js",
    );
    expect(normalizePath("/src/App.tsx")).toBe("/src/App.tsx");
  });

  it("keeps static routes untouched", () => {
    expect(normalizePath("/api/v1/projects/settings")).toBe(
      "/api/v1/projects/settings",
    );
  });
});

describe("normalizeFilename", () => {
  it("removes query strings and normalizes unstable values", () => {
    expect(
      normalizeFilename("http://localhost:5173/src/App.tsx?t=1789607822887"),
    ).toBe("/src/App.tsx");
    expect(normalizeFilename("https://app.example.com/orders/7192381")).toBe(
      "/orders/:id",
    );
  });

  it("collapses browser-extension frames", () => {
    expect(normalizeFilename("chrome-extension://abcdefg/inject.js")).toBe(
      "browser-extension",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeFilename("   ")).toBe("");
  });
});

describe("normalizeStackFrame and selectTopFrames", () => {
  it("builds canonical frames with function, file and line", () => {
    const frame = normalizeStackFrame({
      filename: "https://app.example.com/assets/index-Bx3K9mPQ.js",
      function: "handleClick",
      lineno: 42,
      colno: 7,
      in_app: true,
    });
    expect(frame).not.toBeNull();
    expect(frame?.file).toBe("/assets/index-:hash.js");
    expect(formatStackFrame(frame!)).toBe(
      "handleClick@/assets/index-:hash.js:42",
    );
  });

  it("returns null for frames without information", () => {
    expect(normalizeStackFrame({})).toBeNull();
    expect(normalizeStackFrame({ in_app: true })).toBeNull();
  });

  it("uses <anonymous> when the function name is missing", () => {
    const frame = normalizeStackFrame({ filename: "/src/App.tsx" });
    expect(formatStackFrame(frame!)).toBe("<anonymous>@/src/App.tsx");
  });

  it("prefers in-application frames", () => {
    const frames = [
      { filename: "/vendor/lib.js", function: "lib", in_app: false },
      { filename: "/src/App.tsx", function: "App", lineno: 10, in_app: true },
      {
        filename: "/src/other.tsx",
        function: "other",
        lineno: 20,
        in_app: true,
      },
    ];
    const selected = selectTopFrames(frames, 5);
    expect(selected.map(formatStackFrame)).toEqual([
      "App@/src/App.tsx:10",
      "other@/src/other.tsx:20",
    ]);
  });

  it("falls back to any frame when in_app is not marked", () => {
    const frames = [
      { filename: "/a.js", function: "a", lineno: 1 },
      { filename: "/b.js", function: "b", lineno: 2 },
    ];
    const selected = selectTopFrames(frames, 5);
    expect(selected).toHaveLength(2);
    expect(selected[0]?.file).toBe("/a.js");
  });

  it("bounds the number of selected frames", () => {
    const frames = Array.from({ length: 20 }, (_value, index) => ({
      filename: `/src/f${index}.ts`,
      function: `f${index}`,
      lineno: index + 1,
      in_app: true,
    }));
    expect(selectTopFrames(frames, 5)).toHaveLength(5);
  });

  it("keeps grouping stable when only the column changes", () => {
    const first = selectTopFrames([
      {
        filename: "/src/App.tsx",
        function: "App",
        lineno: 10,
        colno: 1,
        in_app: true,
      },
    ]);
    const second = selectTopFrames([
      {
        filename: "/src/App.tsx",
        function: "App",
        lineno: 10,
        colno: 99,
        in_app: true,
      },
    ]);
    expect(first).toEqual(second);
  });
});

describe("placeholder contract", () => {
  it("exposes stable placeholders", () => {
    expect(NORMALIZED_PLACEHOLDER).toEqual({
      id: ":id",
      timestamp: ":timestamp",
      hex: ":hex",
      address: ":addr",
      token: ":token",
      hash: ":hash",
    });
  });
});
