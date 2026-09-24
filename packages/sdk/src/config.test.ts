// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSessionId, generateUuid } from "./config.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Session shape: 8-4-4-4-6 hex with `4`/`8` version markers preserved.
const SESSION_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{6}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("generateUuid (Web Crypto)", () => {
  it("matches UUID shape with version 4 and RFC variant bits", () => {
    for (let i = 0; i < 25; i += 1) {
      const id = generateUuid();
      expect(id).toMatch(UUID_V4);
      expect(id.charAt(14)).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(id.charAt(19));
    }
  });

  it("yields distinct values on repeated generation", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateUuid());
    }
    expect(seen.size).toBe(50);
  });

  it("uses the Web Crypto path (no Math.random in ID generation)", () => {
    const randomSpy = vi.spyOn(Math, "random");
    const getRandomValuesSpy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const randomUuidSpy =
      typeof globalThis.crypto.randomUUID === "function"
        ? vi.spyOn(globalThis.crypto, "randomUUID")
        : null;
    generateUuid();
    generateSessionId();
    expect(randomSpy).not.toHaveBeenCalled();
    const cryptoCalls =
      getRandomValuesSpy.mock.calls.length +
      (randomUuidSpy?.mock.calls.length ?? 0);
    expect(cryptoCalls).toBeGreaterThan(0);
  });

  it("builds a compliant UUID v4 from mocked crypto bytes", () => {
    const bytes = new Uint8Array(16).fill(0xab);
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes);
        return target;
      },
    });
    // 0xab with version nibble 4 and variant bits 10:
    // byte[6] -> 0x4b, byte[8] -> 0xab.
    expect(generateUuid()).toBe("abababab-abab-4bab-abab-abababababab");
  });

  it("fails closed when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => generateUuid()).toThrow(/Web Crypto/);
    expect(() => generateSessionId()).toThrow(/Web Crypto/);
  });
});

describe("generateSessionId (Web Crypto)", () => {
  it("preserves the timestamp-prefixed sortable shape", () => {
    const id = generateSessionId();
    expect(id).toMatch(SESSION_SHAPE);
  });

  it("embeds the current timestamp prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
    const ts = Date.now().toString(16).padStart(12, "0");
    const id = generateSessionId();
    expect(id.startsWith(`${ts.slice(0, 8)}-${ts.slice(8)}-`)).toBe(true);
  });

  it("yields distinct session IDs on repeated generation", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateSessionId());
    }
    expect(seen.size).toBe(50);
  });

  it("derives randomness from mocked crypto bytes deterministically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0x123456789abc);
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.set([0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
        return target;
      },
    });
    // random hex "0123456789ab" with the retained 4/8 markers.
    expect(generateSessionId()).toBe("12345678-9abc-4012-8345-6789ab");
  });
});
