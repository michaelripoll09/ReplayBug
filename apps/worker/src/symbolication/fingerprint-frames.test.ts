import { describe, expect, it } from "vitest";
import { selectMappedFingerprintFrames } from "./fingerprint-frames.js";
import type {
  MappedSymbolicationFrame,
  RawSymbolicationFrame,
  SymbolicationResult,
} from "./types.js";

function rawFrame(
  overrides: Partial<RawSymbolicationFrame> = {},
): RawSymbolicationFrame {
  return {
    filename: "https://cdn.example.com/assets/app-AAA.js",
    function: "a",
    lineno: 1,
    colno: 100,
    inApp: true,
    ...overrides,
  };
}

function mappedFrame(
  overrides: Partial<MappedSymbolicationFrame> = {},
): MappedSymbolicationFrame {
  return {
    filename: "src/features/checkout/CheckoutButton.tsx",
    source: "src/features/checkout/CheckoutButton.tsx",
    function: "onCheckoutClick",
    name: "onCheckoutClick",
    line: 84,
    column: 1,
    inApplication: true,
    mapped: true,
    ...overrides,
  };
}

function unmappedFrame(raw: RawSymbolicationFrame): MappedSymbolicationFrame {
  return {
    filename: raw.filename,
    source: raw.filename,
    function: raw.function,
    name: null,
    line: raw.lineno,
    column: raw.colno,
    inApplication: raw.inApp,
    mapped: false,
  };
}

function resultOf(
  rawFrames: RawSymbolicationFrame[],
  mappedFrames: MappedSymbolicationFrame[],
): SymbolicationResult {
  return {
    status: "mapped",
    rawFrames,
    mappedFrames,
    mappedFrameCount: mappedFrames.filter((f) => f.mapped).length,
  };
}

describe("selectMappedFingerprintFrames (RS-09)", () => {
  it("returns mapped original frames in stack order with display coords", () => {
    const raw = [rawFrame()];
    const result = resultOf(raw, [mappedFrame()]);
    const selected = selectMappedFingerprintFrames(result);
    expect(selected).not.toBeNull();
    expect(selected).toEqual([
      {
        filename: "src/features/checkout/CheckoutButton.tsx",
        function: "onCheckoutClick",
        lineno: 84,
        colno: 1,
        in_app: true,
      },
    ]);
  });

  it("returns null when nothing is mapped (no-map fallback unchanged)", () => {
    const raw = [rawFrame()];
    const result = resultOf(raw, [
      unmappedFrame(raw[0] as RawSymbolicationFrame),
    ]);
    expect(selectMappedFingerprintFrames(result)).toBeNull();
  });

  it("returns null when mapped frames exist but none are in-application", () => {
    const raw = [rawFrame({ inApp: false })];
    const mapped = [mappedFrame({ inApplication: false, mapped: true })];
    expect(selectMappedFingerprintFrames(resultOf(raw, mapped))).toBeNull();
  });

  it("returns null for empty stacks", () => {
    const result: SymbolicationResult = {
      status: "mapped",
      rawFrames: [],
      mappedFrames: [],
      mappedFrameCount: 0,
    };
    expect(selectMappedFingerprintFrames(result)).toBeNull();
  });

  it("keeps raw fallback only where needed, preserving stack order", () => {
    const first = rawFrame({
      filename: "https://cdn.example.com/assets/app-AAA.js",
      colno: 100,
    });
    const second = rawFrame({
      filename: "https://cdn.example.com/assets/missing.js",
      function: "b",
      lineno: 5,
      colno: 5,
    });
    const result = resultOf(
      [first, second],
      [mappedFrame(), unmappedFrame(second)],
    );
    const selected = selectMappedFingerprintFrames(result);
    expect(selected).toEqual([
      {
        filename: "src/features/checkout/CheckoutButton.tsx",
        function: "onCheckoutClick",
        lineno: 84,
        colno: 1,
        in_app: true,
      },
      {
        filename: "https://cdn.example.com/assets/missing.js",
        function: "b",
        lineno: 5,
        colno: 5,
        in_app: true,
      },
    ]);
  });

  it("is deterministic for identical input", () => {
    const raw = [rawFrame()];
    const first = selectMappedFingerprintFrames(resultOf(raw, [mappedFrame()]));
    const second = selectMappedFingerprintFrames(
      resultOf(raw, [mappedFrame()]),
    );
    expect(first).toEqual(second);
  });

  it("returns null when raw and mapped lengths diverge (defensive raw path)", () => {
    const raw = [rawFrame(), rawFrame()];
    const result = resultOf(raw, [mappedFrame()]);
    expect(selectMappedFingerprintFrames(result)).toBeNull();
  });
});
