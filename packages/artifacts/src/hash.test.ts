import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { computeContentHash, hashFile, hashStream, sha256Hex } from "./hash.js";

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes empty input to the empty-string digest", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("computeContentHash", () => {
  it("matches createHash for random bytes", () => {
    const bytes = randomBytes(1024);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(computeContentHash(bytes)).toBe(expected);
  });
});

describe("hashStream", () => {
  it("computes hash and size in a single streaming pass", async () => {
    const bytes = randomBytes(64 * 1024);
    const expected = createHash("sha256").update(bytes).digest("hex");
    const result = await hashStream(Readable.from([bytes]));
    expect(result).toEqual({ contentHash: expected, sizeBytes: bytes.length });
  });

  it("handles multi-chunk streams and empty streams", async () => {
    const chunks = [randomBytes(10), randomBytes(0), randomBytes(777)];
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const expected = createHash("sha256");
    for (const chunk of chunks) {
      expected.update(chunk);
    }
    const result = await hashStream(
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
    );
    expect(result).toEqual({
      contentHash: expected.digest("hex"),
      sizeBytes: total,
    });

    const empty = await hashStream(Readable.from([]));
    expect(empty).toEqual({
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 0,
    });
  });
});

describe("hashFile", () => {
  it("is covered by LocalArtifactStorage round-trip tests", () => {
    expect(typeof hashFile).toBe("function");
  });
});
