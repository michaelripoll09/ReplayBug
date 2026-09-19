import { describe, expect, it } from "vitest";
import {
  ALLOWED_ARTIFACT_EXTENSIONS,
  PREFLIGHT_MAX_ENTRIES,
  UPLOAD_AGGREGATE_MAX_BYTES,
  artifactTypeForExtension,
  assertSafeAssetContent,
  detectProhibitedContent,
  extensionOfArtifactPath,
  validateArtifactExtension,
  validateArtifactMimeType,
} from "./upload-policy.js";
import { InvalidArtifactTypeError } from "./errors.js";

/**
 * RS-06 upload policy (TDD): JS symbolication is the goal, so only
 * `.map/.js/.mjs/.cjs` are allowlisted (`.css` stays out). MIME checks
 * tolerate realistic CLI multipart types while extension/content rules
 * stay authoritative; renamed binaries and markup fail closed.
 */
describe("upload policy extensions", () => {
  it("allowlists exactly the JS symbolication set", () => {
    expect([...ALLOWED_ARTIFACT_EXTENSIONS].sort()).toEqual(
      [".cjs", ".js", ".map", ".mjs"].sort(),
    );
  });

  it("derives lowercase extensions from canonical paths", () => {
    expect(extensionOfArtifactPath("assets/app.js.map")).toBe(".map");
    expect(extensionOfArtifactPath("assets/app.JS")).toBe(".js");
    expect(extensionOfArtifactPath("assets/app.Mjs")).toBe(".mjs");
    expect(extensionOfArtifactPath("noext")).toBe("");
  });

  it("maps extensions to artifact types", () => {
    expect(artifactTypeForExtension(".map")).toBe("source_map");
    expect(artifactTypeForExtension(".js")).toBe("minified_asset");
    expect(artifactTypeForExtension(".mjs")).toBe("minified_asset");
    expect(artifactTypeForExtension(".cjs")).toBe("minified_asset");
  });

  it.each([
    ["executable", "payload.exe"],
    ["markup html", "page.html"],
    ["markup svg", "image.svg"],
    ["stylesheet", "styles.css"],
    ["no extension", "README"],
    ["archive", "bundle.zip"],
    ["empty extension", "file."],
  ])("rejects %s (%s)", (_label, candidate) => {
    expect(() => validateArtifactExtension(candidate)).toThrow(
      InvalidArtifactTypeError,
    );
    expect(() =>
      artifactTypeForExtension(extensionOfArtifactPath(candidate)),
    ).toThrow(InvalidArtifactTypeError);
  });

  it("accepts allowlisted extensions via validateArtifactExtension", () => {
    expect(validateArtifactExtension("assets/app.js.map")).toBe(".map");
    expect(validateArtifactExtension("assets/app.js")).toBe(".js");
  });
});

describe("upload policy MIME", () => {
  it.each([
    ["octet-stream default", "application/octet-stream"],
    ["json map", "application/json"],
    ["javascript text", "text/javascript"],
    ["javascript app", "application/javascript"],
    ["plain text", "text/plain"],
    ["legacy js", "application/x-javascript"],
    ["with charset", "application/json; charset=utf-8"],
    ["uppercase", "Application/Octet-Stream"],
  ])("tolerates %s (%s)", (_label, mime) => {
    expect(() => validateArtifactMimeType(mime, ".map")).not.toThrow();
    expect(() => validateArtifactMimeType(mime, ".js")).not.toThrow();
  });

  it("tolerates missing MIME types", () => {
    expect(() => validateArtifactMimeType(undefined, ".map")).not.toThrow();
    expect(() => validateArtifactMimeType("", ".js")).not.toThrow();
  });

  it.each([
    ["html", "text/html"],
    ["svg", "image/svg+xml"],
    ["executable", "application/x-msdownload"],
    ["pdf", "application/pdf"],
  ])("rejects %s (%s)", (_label, mime) => {
    expect(() => validateArtifactMimeType(mime, ".js")).toThrow(
      InvalidArtifactTypeError,
    );
    expect(() => validateArtifactMimeType(mime, ".map")).toThrow(
      InvalidArtifactTypeError,
    );
  });
});

describe("upload policy prohibited content", () => {
  it("flags Windows and ELF executables by magic bytes", () => {
    expect(
      detectProhibitedContent(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])),
    ).toBe("executable");
    expect(
      detectProhibitedContent(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])),
    ).toBe("executable");
  });

  it("flags markup payloads renamed to asset extensions", () => {
    expect(detectProhibitedContent(toBytes("<!DOCTYPE html>"))).toBe("markup");
    expect(detectProhibitedContent(toBytes("  <html>"))).toBe("markup");
    expect(detectProhibitedContent(toBytes("\n<svg width='1'>"))).toBe(
      "markup",
    );
  });

  it("passes real JS and map bytes", () => {
    expect(
      detectProhibitedContent(
        toBytes('console.log("hi");//# sourceMappingURL=app.js.map'),
      ),
    ).toBeNull();
    expect(
      detectProhibitedContent(
        toBytes('{"version":3,"sources":[],"mappings":""}'),
      ),
    ).toBeNull();
    expect(detectProhibitedContent(new Uint8Array([]))).toBeNull();
  });

  it("assertSafeAssetContent throws a typed error on hits", () => {
    expect(() => assertSafeAssetContent(new Uint8Array([0x4d, 0x5a]))).toThrow(
      InvalidArtifactTypeError,
    );
    expect(() => assertSafeAssetContent(toBytes("var a = 1;"))).not.toThrow();
  });
});

describe("upload policy caps", () => {
  it("pins the manifest and aggregate caps", () => {
    expect(PREFLIGHT_MAX_ENTRIES).toBe(500);
    expect(UPLOAD_AGGREGATE_MAX_BYTES).toBe(250 * 1024 * 1024);
  });
});

function toBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
