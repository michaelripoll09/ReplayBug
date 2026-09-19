import { describe, expect, it } from "vitest";
import {
  buildArtifactStorageKey,
  parseArtifactStorageKey,
  resolveStoragePath,
  validateStorageKey,
  STORAGE_KEY_MAX_LENGTH,
} from "./storage-keys.js";
import { ArtifactKeyError } from "./errors.js";

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";
const RELEASE_ID = "223e4567-e89b-12d3-a456-426614174001";
const CONTENT_HASH =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("validateStorageKey", () => {
  it("accepts server-generated project/release/hash keys", () => {
    const key = `${PROJECT_ID}/${RELEASE_ID}/${CONTENT_HASH}`;
    expect(validateStorageKey(key)).toBe(key);
  });

  it("accepts single-segment keys", () => {
    expect(validateStorageKey("abc123")).toBe("abc123");
  });

  it.each([
    ["empty string", ""],
    ["dot segment", "a/./b"],
    ["dotdot segment", "a/../b"],
    ["bare dotdot", ".."],
    ["absolute posix", "/etc/passwd"],
    ["empty segment", "a//b"],
    ["trailing slash", "a/b/"],
    ["leading slash", "/a/b"],
    ["backslash", "a\\b"],
    ["windows drive", "C:/x"],
    ["drive-relative", "C:foo"],
    ["colon segment", "a:b"],
    ["NUL byte", "a\0b"],
    ["newline", "a\nb"],
    ["space", "a b"],
    ["unicode", "caf\u00e9/x"],
    ["glob star", "a/*/b"],
  ])("rejects %s", (_label, key) => {
    expect(() => validateStorageKey(key)).toThrow(ArtifactKeyError);
  });

  it("rejects non-string input", () => {
    expect(() => validateStorageKey(undefined)).toThrow(ArtifactKeyError);
    expect(() => validateStorageKey(42)).toThrow(ArtifactKeyError);
    expect(() => validateStorageKey(null)).toThrow(ArtifactKeyError);
  });

  it("rejects over-long keys", () => {
    const longSegment = `a${"x".repeat(200)}`;
    expect(() => validateStorageKey(longSegment)).toThrow(ArtifactKeyError);
    const longKey = `${"a".repeat(64)}/${"b".repeat(64)}/${"x".repeat(STORAGE_KEY_MAX_LENGTH)}`;
    expect(() => validateStorageKey(longKey)).toThrow(ArtifactKeyError);
  });
});

describe("buildArtifactStorageKey", () => {
  it("builds the canonical project/release/hash layout", () => {
    expect(buildArtifactStorageKey(PROJECT_ID, RELEASE_ID, CONTENT_HASH)).toBe(
      `${PROJECT_ID}/${RELEASE_ID}/${CONTENT_HASH}`,
    );
  });

  it("rejects malformed ids and hashes", () => {
    expect(() =>
      buildArtifactStorageKey("not-a-uuid", RELEASE_ID, CONTENT_HASH),
    ).toThrow(ArtifactKeyError);
    expect(() =>
      buildArtifactStorageKey(PROJECT_ID, "short", CONTENT_HASH),
    ).toThrow(ArtifactKeyError);
    expect(() =>
      buildArtifactStorageKey(PROJECT_ID, RELEASE_ID, "xyz"),
    ).toThrow(ArtifactKeyError);
    expect(() =>
      buildArtifactStorageKey(
        PROJECT_ID,
        RELEASE_ID,
        CONTENT_HASH.toUpperCase(),
      ),
    ).toThrow(ArtifactKeyError);
  });
});

describe("parseArtifactStorageKey", () => {
  it("round-trips canonical keys", () => {
    const key = buildArtifactStorageKey(PROJECT_ID, RELEASE_ID, CONTENT_HASH);
    expect(parseArtifactStorageKey(key)).toEqual({
      projectId: PROJECT_ID,
      releaseId: RELEASE_ID,
      contentHash: CONTENT_HASH,
    });
  });

  it("rejects non-canonical shapes", () => {
    expect(() => parseArtifactStorageKey("just-one-segment")).toThrow(
      ArtifactKeyError,
    );
    expect(() =>
      parseArtifactStorageKey(`${PROJECT_ID}/${RELEASE_ID}`),
    ).toThrow(ArtifactKeyError);
    expect(() =>
      parseArtifactStorageKey(
        `${PROJECT_ID}/${RELEASE_ID}/${CONTENT_HASH}/extra`,
      ),
    ).toThrow(ArtifactKeyError);
  });
});

describe("resolveStoragePath", () => {
  const root =
    process.platform === "win32" ? "C:\\artifacts-root" : "/artifacts-root";

  it("resolves keys inside the root", () => {
    const key = buildArtifactStorageKey(PROJECT_ID, RELEASE_ID, CONTENT_HASH);
    const resolved = resolveStoragePath(root, key);
    expect(resolved.startsWith(`${root}${sep()}`)).toBe(true);
    expect(resolved).toContain(CONTENT_HASH);
  });

  it("keeps adversarial keys inside the root", () => {
    const adversarial = [
      "../../evil",
      "a/../../../evil",
      "/absolute",
      "C:/windows",
      "..",
      "a/..",
    ];
    for (const key of adversarial) {
      expect(() => resolveStoragePath(root, key)).toThrow(ArtifactKeyError);
    }
  });
});

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
