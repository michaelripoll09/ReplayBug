import { describe, expect, it } from "vitest";
import {
  ReleaseValidationError,
  validateArtifactPath,
  validateArtifactType,
  validateCommitSha,
  validateContentHash,
  validateReleaseVersion,
  validateRepositoryUrl,
  validateSizeBytes,
  validateStorageKey,
} from "./releases.js";

/**
 * RS-04 release validation (pure, synchronous, shape-only — never fetches).
 * Version strings are intentionally NOT semver-restricted: `web@1.4.2`,
 * `demo@2026.09.18` and `1.4.2` are all valid. Artifact path traversal
 * rejection is RS-06; here the path guard is NOT NULL + length only.
 */
describe("release validation (RS-04)", () => {
  describe("validateReleaseVersion", () => {
    it("accepts plain, scoped and date versions", () => {
      expect(validateReleaseVersion("web@1.4.2")).toBe("web@1.4.2");
      expect(validateReleaseVersion("demo@2026.09.18")).toBe("demo@2026.09.18");
      expect(validateReleaseVersion("1.4.2")).toBe("1.4.2");
      expect(validateReleaseVersion("x")).toBe("x");
      expect(validateReleaseVersion("v1.0.0-beta+build.5")).toBe(
        "v1.0.0-beta+build.5",
      );
    });

    it("accepts a 128-character version", () => {
      const version = `v${"a".repeat(127)}`;
      expect(version.length).toBe(128);
      expect(validateReleaseVersion(version)).toBe(version);
    });

    it("rejects empty, over-long and non-string versions", () => {
      expect(() => validateReleaseVersion("")).toThrow(ReleaseValidationError);
      expect(() => validateReleaseVersion(`v${"a".repeat(128)}`)).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateReleaseVersion(42)).toThrow(ReleaseValidationError);
      expect(() => validateReleaseVersion(null)).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateReleaseVersion(undefined)).toThrow(
        ReleaseValidationError,
      );
    });

    it("rejects control characters without trimming or mutating", () => {
      const bad = [
        "v1.0\n",
        "v\t1.0",
        "v1.0\r\n",
        `v1.0${String.fromCharCode(0)}`,
        `v1.0${String.fromCharCode(127)}`,
        " 1.4.2\n",
      ];
      for (const candidate of bad) {
        expect(() => validateReleaseVersion(candidate)).toThrow(
          ReleaseValidationError,
        );
      }
    });
  });

  describe("validateCommitSha", () => {
    it("maps null/undefined to null", () => {
      expect(validateCommitSha(null)).toBeNull();
      expect(validateCommitSha(undefined)).toBeNull();
    });

    it("accepts short, full and long git SHAs in either hex case", () => {
      expect(validateCommitSha("abc1234")).toBe("abc1234");
      expect(validateCommitSha("a".repeat(40))).toBe("a".repeat(40));
      expect(validateCommitSha("F".repeat(64))).toBe("F".repeat(64));
    });

    it("rejects too-short, too-long, non-hex and empty SHAs", () => {
      expect(() => validateCommitSha("abc123")).toThrow(ReleaseValidationError);
      expect(() => validateCommitSha("a".repeat(65))).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateCommitSha("zzzzzzz")).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateCommitSha("")).toThrow(ReleaseValidationError);
      expect(() => validateCommitSha("abc 1234")).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateCommitSha(1234567)).toThrow(ReleaseValidationError);
    });
  });

  describe("validateRepositoryUrl", () => {
    it("maps null/undefined to null and accepts http/https shapes", () => {
      expect(validateRepositoryUrl(null)).toBeNull();
      expect(validateRepositoryUrl(undefined)).toBeNull();
      expect(validateRepositoryUrl("https://github.com/acme/app")).toBe(
        "https://github.com/acme/app",
      );
      expect(validateRepositoryUrl("http://git.internal/acme/app.git")).toBe(
        "http://git.internal/acme/app.git",
      );
    });

    it("rejects non-http schemes, bare hosts and bad shapes", () => {
      const bad = [
        "",
        "ftp://example.com/app.git",
        "git@github.com:acme/app.git",
        "github.com/acme/app",
        "//github.com/acme/app",
        "https://",
        "https://exa mple.com/app",
        "https://example.com/app\n",
      ];
      for (const candidate of bad) {
        expect(() => validateRepositoryUrl(candidate)).toThrow(
          ReleaseValidationError,
        );
      }
      expect(() => validateRepositoryUrl(42)).toThrow(ReleaseValidationError);
    });

    it("rejects URLs longer than 2048 characters", () => {
      const long = `https://example.com/${"a".repeat(2048)}`;
      expect(long.length).toBeGreaterThan(2048);
      expect(() => validateRepositoryUrl(long)).toThrow(ReleaseValidationError);
      const prefix = "https://example.com/";
      const max = `${prefix}${"a".repeat(2048 - prefix.length)}`;
      expect(max.length).toBe(2048);
      expect(validateRepositoryUrl(max)).toBe(max);
    });
  });

  describe("validateArtifactPath (RS-04 minimal guard)", () => {
    it("accepts POSIX relative paths", () => {
      expect(validateArtifactPath("assets/app.js")).toBe("assets/app.js");
      expect(validateArtifactPath("app.map")).toBe("app.map");
    });

    it("rejects empty, over-long, NUL and non-string paths", () => {
      expect(() => validateArtifactPath("")).toThrow(ReleaseValidationError);
      expect(() => validateArtifactPath("a".repeat(1025))).toThrow(
        ReleaseValidationError,
      );
      expect(() =>
        validateArtifactPath(`a${String.fromCharCode(0)}b.js`),
      ).toThrow(ReleaseValidationError);
      expect(() => validateArtifactPath(42)).toThrow(ReleaseValidationError);
      expect(validateArtifactPath("a".repeat(1024)).length).toBe(1024);
    });
  });

  describe("validateContentHash", () => {
    it("accepts 64 lowercase hex chars", () => {
      const hash = "a".repeat(64);
      expect(validateContentHash(hash)).toBe(hash);
      expect(validateContentHash("0123456789abcdef".repeat(4))).toBe(
        "0123456789abcdef".repeat(4),
      );
    });

    it("rejects uppercase, wrong length and non-hex hashes", () => {
      expect(() => validateContentHash("A".repeat(64))).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateContentHash("a".repeat(63))).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateContentHash("a".repeat(65))).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateContentHash("")).toThrow(ReleaseValidationError);
      expect(() => validateContentHash("x".repeat(64))).toThrow(
        ReleaseValidationError,
      );
    });
  });

  describe("validateArtifactType", () => {
    it("accepts the two known artifact types", () => {
      expect(validateArtifactType("source_map")).toBe("source_map");
      expect(validateArtifactType("minified_asset")).toBe("minified_asset");
    });

    it("rejects unknown types", () => {
      expect(() => validateArtifactType("bundle")).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateArtifactType("")).toThrow(ReleaseValidationError);
    });
  });

  describe("validateSizeBytes", () => {
    it("accepts zero and positive integers", () => {
      expect(validateSizeBytes(0)).toBe(0);
      expect(validateSizeBytes(25 * 1024 * 1024)).toBe(25 * 1024 * 1024);
    });

    it("rejects negative, fractional and non-numeric sizes", () => {
      expect(() => validateSizeBytes(-1)).toThrow(ReleaseValidationError);
      expect(() => validateSizeBytes(1.5)).toThrow(ReleaseValidationError);
      expect(() => validateSizeBytes(Number.NaN)).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateSizeBytes("100")).toThrow(ReleaseValidationError);
    });
  });

  describe("validateStorageKey", () => {
    it("accepts non-empty server-generated keys up to 1024 chars", () => {
      expect(validateStorageKey("proj/rel/hash")).toBe("proj/rel/hash");
      expect(validateStorageKey("k".repeat(1024)).length).toBe(1024);
    });

    it("rejects empty, over-long and non-string keys", () => {
      expect(() => validateStorageKey("")).toThrow(ReleaseValidationError);
      expect(() => validateStorageKey("k".repeat(1025))).toThrow(
        ReleaseValidationError,
      );
      expect(() => validateStorageKey(42)).toThrow(ReleaseValidationError);
    });
  });
});
