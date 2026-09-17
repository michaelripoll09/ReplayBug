import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME } from "./index.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, "..", "bin", "replaybug.js");

describe("@replaybug/cli foundation", () => {
  it("exposes the replaybug executable name", () => {
    expect(CLI_NAME).toBe("replaybug");
  });

  it("prints a semver version for --version", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      binPath,
      "--version",
    ]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints usage for --help", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      binPath,
      "--help",
    ]);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--version");
  });
});
