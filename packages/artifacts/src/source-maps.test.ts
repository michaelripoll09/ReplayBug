import { describe, expect, it } from "vitest";
import { validateSourceMapBytes } from "./source-maps.js";
import { InvalidSourceMapError } from "./errors.js";

/**
 * RS-06 Source Map v3 validation (TDD): `.map` uploads must parse as
 * Source Map v3 JSON before anything is persisted. Malformed maps fail
 * with INVALID_SOURCE_MAP and leave no row and no file behind.
 */
describe("validateSourceMapBytes", () => {
  const minimal = {
    version: 3,
    sources: ["../src/app.ts"],
    names: [],
    mappings: "AAAA",
  };

  it("accepts a minimal v3 map", () => {
    const doc = validateSourceMapBytes(toBytes(JSON.stringify(minimal)));
    expect(doc.version).toBe(3);
    expect(doc.sources).toEqual(["../src/app.ts"]);
    expect(doc.mappings).toBe("AAAA");
  });

  it("accepts optional file/sourceRoot/names/sourcesContent", () => {
    const full = {
      version: 3,
      file: "app.js",
      sourceRoot: "/the/root",
      sources: ["a.ts", "b.ts"],
      sourcesContent: ["const a = 1;", null],
      names: ["foo", "bar"],
      mappings: "AAAA,CAAC;",
    };
    const doc = validateSourceMapBytes(toBytes(JSON.stringify(full)));
    expect(doc.file).toBe("app.js");
    expect(doc.sourceRoot).toBe("/the/root");
    expect(doc.names).toEqual(["foo", "bar"]);
  });

  it.each([
    ["empty bytes", ""],
    ["not JSON", "not json at all"],
    ["truncated JSON", '{"version": 3,'],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"hello"'],
    ["missing version", '{"sources":[],"mappings":""}'],
    ["version 2", '{"version":2,"sources":[],"mappings":""}'],
    ["version string", '{"version":"3","sources":[],"mappings":""}'],
    ["missing sources", '{"version":3,"mappings":""}'],
    ["sources not array", '{"version":3,"sources":{},"mappings":""}'],
    ["sources non-string entry", '{"version":3,"sources":[42],"mappings":""}'],
    ["missing mappings", '{"version":3,"sources":[]}'],
    ["mappings not string", '{"version":3,"sources":[],"mappings":42}'],
    ["names not array", '{"version":3,"sources":[],"mappings":"","names":{}}'],
    [
      "names non-string entry",
      '{"version":3,"sources":[],"mappings":"","names":[null]}',
    ],
    ["file not string", '{"version":3,"sources":[],"mappings":"","file":42}'],
    [
      "sourceRoot not string",
      '{"version":3,"sources":[],"mappings":"","sourceRoot":false}',
    ],
    ["index map without mappings", '{"version":3,"sources":[],"sections":[]}'],
  ])("rejects %s", (_label, body) => {
    expect(() => validateSourceMapBytes(toBytes(body))).toThrow(
      InvalidSourceMapError,
    );
  });

  it("rejects renamed binaries and markup as maps", () => {
    expect(() =>
      validateSourceMapBytes(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])),
    ).toThrow(InvalidSourceMapError);
    expect(() =>
      validateSourceMapBytes(toBytes("<!doctype html><html></html>")),
    ).toThrow(InvalidSourceMapError);
    expect(() => validateSourceMapBytes(toBytes("<svg></svg>"))).toThrow(
      InvalidSourceMapError,
    );
  });

  it("rejects invalid UTF-8", () => {
    expect(() =>
      validateSourceMapBytes(new Uint8Array([0xff, 0xfe, 0x00])),
    ).toThrow(InvalidSourceMapError);
  });

  it("never returns executable content, only the validated view", () => {
    const doc = validateSourceMapBytes(toBytes(JSON.stringify(minimal)));
    expect(Object.keys(doc).sort()).toEqual(
      ["mappings", "names", "sources", "version"].sort(),
    );
    expect(JSON.stringify(doc)).not.toContain("function");
  });
});

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
