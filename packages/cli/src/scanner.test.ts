import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSourcemapDirectory } from "./scanner.js";
import { CliError } from "./errors.js";

const VALID_MAP = JSON.stringify({
  version: 3,
  sources: ["../../src/app.ts"],
  names: [],
  mappings: "AAAA",
});

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rs07-scan-"));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("sourcemap scanner", () => {
  it("collects sibling maps and assets with hashes in deterministic order", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "assets"), { recursive: true });
    const js = "console.log(1);\n//# sourceMappingURL=index-ABC.js.map\n";
    await writeFile(join(root, "assets", "index-ABC.js"), js);
    await writeFile(join(root, "assets", "index-ABC.js.map"), VALID_MAP);
    await writeFile(join(root, "index.html"), "<html></html>");
    await writeFile(join(root, "notes.txt"), "ignore me");

    const result = await scanSourcemapDirectory(root);
    expect(result.warnings).toEqual([]);
    expect(result.artifacts.map((a) => a.artifactPath)).toEqual([
      "assets/index-ABC.js",
      "assets/index-ABC.js.map",
    ]);
    const map = result.artifacts.find(
      (a) => a.artifactPath === "assets/index-ABC.js.map",
    );
    expect(map?.artifactType).toBe("source_map");
    expect(map?.contentHash).toBe(sha256Hex(VALID_MAP));
    expect(map?.sizeBytes).toBe(Buffer.byteLength(VALID_MAP));
    const asset = result.artifacts.find(
      (a) => a.artifactPath === "assets/index-ABC.js",
    );
    expect(asset?.artifactType).toBe("minified_asset");
    expect(asset?.contentHash).toBe(sha256Hex(js));
  });

  it("ignores lone assets but honors map file hints and sourceMappingURL", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "static", "maps"), { recursive: true });
    // Lone asset with no map association: ignored.
    await writeFile(join(root, "static", "vendor.js"), "var x = 1;\n");
    // Asset paired only via the map `file` hint.
    const hintedMap = JSON.stringify({
      version: 3,
      file: "bundle-lazy.js",
      sources: ["app.ts"],
      names: [],
      mappings: "AAAA",
    });
    await writeFile(join(root, "static", "bundle-lazy.js.map"), hintedMap);
    await writeFile(join(root, "static", "bundle-lazy.js"), "var y = 2;\n");
    // Asset paired only via its own sourceMappingURL into another dir.
    const relocatedMap = JSON.stringify({
      version: 3,
      sources: ["app.ts"],
      names: [],
      mappings: "AAAA",
    });
    await writeFile(join(root, "static", "maps", "chunk.js.map"), relocatedMap);
    await writeFile(
      join(root, "static", "chunk.js"),
      "var z = 3;\n//# sourceMappingURL=maps/chunk.js.map\n",
    );

    const result = await scanSourcemapDirectory(root);
    expect(result.artifacts.map((a) => a.artifactPath)).toEqual([
      "static/bundle-lazy.js",
      "static/bundle-lazy.js.map",
      "static/chunk.js",
      "static/maps/chunk.js.map",
    ]);
  });

  it("never follows remote sourceMappingURL references", async () => {
    const root = await makeRoot();
    // Remote reference with no local map: the asset stays excluded and
    // the URL is never fetched.
    await writeFile(
      join(root, "cdn.js"),
      "var a = 1;\n//# sourceMappingURL=https://cdn.example/cdn.js.map\n",
    );
    await writeFile(join(root, "app.js"), "var b = 2;\n");
    await writeFile(join(root, "app.js.map"), VALID_MAP);

    const result = await scanSourcemapDirectory(root);
    expect(result.artifacts.map((a) => a.artifactPath)).toEqual([
      "app.js",
      "app.js.map",
    ]);
  });

  it("skips symlink escapes with a warning and keeps the good files", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const secret = "outside-bytes";
    await writeFile(join(outside, "secret.js.map"), secret);
    await writeFile(join(root, "ok.js.map"), VALID_MAP);
    try {
      await symlink(join(outside, "secret.js.map"), join(root, "evil.js.map"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: unknown }).code === "EPERM" ||
          (error as { code?: unknown }).code === "EACCES")
      ) {
        return;
      }
      throw error;
    }

    const result = await scanSourcemapDirectory(root);
    expect(result.artifacts.map((a) => a.artifactPath)).toEqual(["ok.js.map"]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join("\n")).toMatch(/symlink/i);
    // The outside bytes are never hashed or collected.
    for (const artifact of result.artifacts) {
      const bytes = await readFile(artifact.absolutePath, "utf8");
      expect(bytes).not.toBe(secret);
    }
  });

  it("rejects missing roots and files with actionable errors", async () => {
    const root = await makeRoot();
    await expect(
      scanSourcemapDirectory(join(root, "nope")),
    ).rejects.toBeInstanceOf(CliError);
    const file = join(root, "file.txt");
    await writeFile(file, "x");
    await expect(scanSourcemapDirectory(file)).rejects.toBeInstanceOf(CliError);
    await expect(scanSourcemapDirectory("   ")).rejects.toBeInstanceOf(
      CliError,
    );
  });
});
