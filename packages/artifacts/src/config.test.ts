import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DIR_ENV_VAR,
  ARTIFACT_MAX_FILE_BYTES_ENV_VAR,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  assertSafeArtifactRoot,
  defaultArtifactDir,
  isSafeArtifactRoot,
  loadArtifactConfigFromEnv,
  parseArtifactMaxFileBytes,
  resolveArtifactDir,
} from "./config.js";
import { ArtifactConfigError } from "./errors.js";

describe("defaultArtifactDir", () => {
  it("lives under the OS home directory, outside any repo checkout", () => {
    const dir = defaultArtifactDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.startsWith(os.homedir() + path.sep)).toBe(true);
    // The test process runs inside the repo checkout, so the default must
    // point outside of it by construction.
    expect(path.relative(process.cwd(), dir).startsWith("..")).toBe(true);
  });
});

describe("isSafeArtifactRoot", () => {
  it("accepts the default and the Docker contract path", () => {
    expect(isSafeArtifactRoot(defaultArtifactDir())).toBe(true);
    const dockerPath =
      process.platform === "win32"
        ? "C:\\var\\lib\\replaybug\\artifacts"
        : "/var/lib/replaybug/artifacts";
    expect(isSafeArtifactRoot(dockerPath)).toBe(true);
  });

  it("accepts OS temp subdirectories (integration-test roots)", () => {
    expect(isSafeArtifactRoot(path.join(os.tmpdir(), "replaybug-test"))).toBe(
      true,
    );
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["relative", "apps/api/uploads"],
    ["dot-relative", "./artifacts"],
    ["repo uploads", "apps/api/uploads"],
  ])("rejects %s paths", (_label, candidate) => {
    expect(isSafeArtifactRoot(candidate)).toBe(false);
  });

  it("rejects filesystem roots, the home dir, and NUL bytes", () => {
    expect(isSafeArtifactRoot(path.parse(process.cwd()).root)).toBe(false);
    expect(isSafeArtifactRoot(os.homedir())).toBe(false);
    expect(isSafeArtifactRoot(`valid\0path`)).toBe(false);
  });

  it("rejects paths inside source-tree containers", () => {
    const join = (...parts: string[]): string =>
      path.resolve(path.parse(process.cwd()).root, ...parts);
    expect(isSafeArtifactRoot(join("repo", "packages", "artifacts"))).toBe(
      false,
    );
    expect(isSafeArtifactRoot(join("repo", "apps", "api", "uploads"))).toBe(
      false,
    );
    expect(isSafeArtifactRoot(join("repo", "public"))).toBe(false);
    expect(isSafeArtifactRoot(join("repo", "src"))).toBe(false);
    expect(isSafeArtifactRoot(join("repo", "x", "node_modules", "y"))).toBe(
      false,
    );
  });
});

describe("assertSafeArtifactRoot", () => {
  it("returns the resolved absolute path for safe roots", () => {
    const dir = path.join(os.tmpdir(), "replaybug-assert");
    expect(assertSafeArtifactRoot(dir)).toBe(path.resolve(dir));
  });

  it("throws ArtifactConfigError for unsafe roots", () => {
    expect(() => assertSafeArtifactRoot("relative/path")).toThrow(
      ArtifactConfigError,
    );
  });
});

describe("resolveArtifactDir", () => {
  it("honours the explicit env var so API and worker can share one directory", () => {
    const dir = path.join(os.tmpdir(), "replaybug-shared");
    expect(resolveArtifactDir({ [ARTIFACT_DIR_ENV_VAR]: dir })).toBe(
      path.resolve(dir),
    );
  });

  it("falls back to the OS-local default when unset", () => {
    expect(resolveArtifactDir({})).toBe(defaultArtifactDir());
  });

  it("fails fast on blank or unsafe explicit values", () => {
    expect(() => resolveArtifactDir({ [ARTIFACT_DIR_ENV_VAR]: "  " })).toThrow(
      ArtifactConfigError,
    );
    expect(() =>
      resolveArtifactDir({ [ARTIFACT_DIR_ENV_VAR]: "relative/uploads" }),
    ).toThrow(ArtifactConfigError);
  });
});

describe("parseArtifactMaxFileBytes", () => {
  it("defaults to 25 MiB", () => {
    expect(parseArtifactMaxFileBytes({})).toBe(25 * 1024 * 1024);
    expect(DEFAULT_ARTIFACT_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });

  it("accepts explicit positive integers", () => {
    expect(
      parseArtifactMaxFileBytes({ [ARTIFACT_MAX_FILE_BYTES_ENV_VAR]: "1" }),
    ).toBe(1);
    expect(
      parseArtifactMaxFileBytes({
        [ARTIFACT_MAX_FILE_BYTES_ENV_VAR]: String(50 * 1024 * 1024),
      }),
    ).toBe(50 * 1024 * 1024);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["float", "1.5"],
    ["nan", "abc"],
  ])("rejects %s", (_label, value) => {
    expect(() =>
      parseArtifactMaxFileBytes({ [ARTIFACT_MAX_FILE_BYTES_ENV_VAR]: value }),
    ).toThrow(ArtifactConfigError);
  });
});

describe("loadArtifactConfigFromEnv", () => {
  it("loads the shared API/worker env contract", () => {
    const dir = path.join(os.tmpdir(), "replaybug-contract");
    const config = loadArtifactConfigFromEnv({
      [ARTIFACT_DIR_ENV_VAR]: dir,
    });
    expect(config.dir).toBe(path.resolve(dir));
    expect(config.maxFileBytes).toBe(DEFAULT_ARTIFACT_MAX_FILE_BYTES);
  });
});
