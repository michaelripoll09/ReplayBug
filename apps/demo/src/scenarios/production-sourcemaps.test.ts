import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(HERE, "..", "..", "dist");
const ASSETS_DIR = resolve(DIST_DIR, "assets");
const SCENARIO_SOURCE_SUFFIX = "src/scenarios/minified-release-error.ts";

interface SourceMapV3 {
  version: number;
  sources: unknown;
  mappings: unknown;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function isJsAsset(name: string): boolean {
  return (
    (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) &&
    !name.endsWith(".map")
  );
}

// The assertions below require a production build. `apps/demo/turbo.json`
// orders `demo#build` before `demo#test`, so both `pnpm test` and bare
// `pnpm turbo test --force` produce `dist` first. Without `dist` these tests
// FAIL on the missing `assets` directory — they never skip. (The release
// string pin lives in `minified-release-error.test.ts`, which needs no
// build output, so it runs even when the build fails.)
describe("production source-map build outputs (RS-11)", () => {
  it("emits hashed JS assets with sibling `.map` files", () => {
    const files = listFiles(ASSETS_DIR);
    const jsAssets = files.filter(isJsAsset);
    expect(jsAssets.length).toBeGreaterThan(0);
    for (const asset of jsAssets) {
      expect(asset).toMatch(/[.-][A-Za-z0-9_-]{6,}\.[cm]?js$/);
      expect(
        existsSync(resolve(ASSETS_DIR, `${asset}.map`)),
        `sibling map for ${asset}`,
      ).toBe(true);
    }
    const maps = files.filter((name) => name.endsWith(".map"));
    expect(maps.length).toBe(jsAssets.length);
    for (const map of maps) {
      expect(
        existsSync(resolve(ASSETS_DIR, map.slice(0, -".map".length))),
        `sibling asset for ${map}`,
      ).toBe(true);
    }
  });

  it("ships valid v3 maps referencing the scenario source", () => {
    const maps = listFiles(ASSETS_DIR).filter((name) => name.endsWith(".map"));
    expect(maps.length).toBeGreaterThan(0);
    for (const map of maps) {
      const parsed = JSON.parse(
        readFileSync(resolve(ASSETS_DIR, map), "utf8"),
      ) as SourceMapV3;
      expect(parsed.version).toBe(3);
      expect(Array.isArray(parsed.sources)).toBe(true);
      const sources = parsed.sources as unknown[];
      expect(sources.length).toBeGreaterThan(0);
      const stringSources = sources.filter(
        (source): source is string => typeof source === "string",
      );
      expect(stringSources.length).toBe(sources.length);
    }
    const allSources = maps.flatMap((map) => {
      const parsed = JSON.parse(
        readFileSync(resolve(ASSETS_DIR, map), "utf8"),
      ) as SourceMapV3;
      return parsed.sources as string[];
    });
    expect(
      allSources.some((source) => source.endsWith(SCENARIO_SOURCE_SUFFIX)),
      `a map references ${SCENARIO_SOURCE_SUFFIX}`,
    ).toBe(true);
  });

  it("keeps maps external: no inline maps, no map references in HTML", () => {
    const jsAssets = listFiles(ASSETS_DIR).filter(isJsAsset);
    for (const asset of jsAssets) {
      const content = readFileSync(resolve(ASSETS_DIR, asset), "utf8");
      expect(content).not.toContain("sourceMappingURL=data:");
    }
    const indexHtml = resolve(DIST_DIR, "index.html");
    expect(existsSync(indexHtml)).toBe(true);
    expect(readFileSync(indexHtml, "utf8")).not.toContain(".map");
  });
});
