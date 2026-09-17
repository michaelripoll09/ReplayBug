#!/usr/bin/env node
/**
 * SDK bundle size measurement script
 * Usage: pnpm sdk:size
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");
const SDK_DIR = join(__dirname, "..", "packages", "sdk");
const DIST_SIZE_DIR = join(SDK_DIR, "dist-size");

function run(cmd, cwd) {
  const workingDir = cwd || SDK_DIR;
  try {
    return execSync(cmd, {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (error) {
    console.error(`Command failed: ${cmd}`);
    throw error;
  }
}

function getFileSize(filePath) {
  return statSync(filePath).size;
}

function gzipSize(data) {
  return new Promise((resolve, reject) => {
    const gzip = createGzip();
    const chunks = [];
    gzip.on("data", (chunk) => chunks.push(chunk));
    gzip.on("end", () => resolve(Buffer.concat(chunks).length));
    gzip.on("error", reject);
    gzip.end(data);
  });
}

async function main() {
  console.log("Building SDK for size measurement...\n");

  // Clean previous dist-size
  if (existsSync(DIST_SIZE_DIR)) {
    rmSync(DIST_SIZE_DIR, { recursive: true });
  }

  // Build ESM only for size measurement
  run(
    "npx tsup src/index.ts --format esm --dts --sourcemap --clean --out-dir dist-size",
  );

  const jsPath = join(DIST_SIZE_DIR, "index.js");

  if (!existsSync(jsPath)) {
    console.error("Build failed: index.js not found");
    process.exit(1);
  }

  // Raw size
  const rawBytes = getFileSize(jsPath);

  // Minified size (using esbuild)
  run(
    "npx esbuild dist-size/index.js --minify --format=esm --outfile=dist-size/index.min.js",
  );
  const minPath = join(DIST_SIZE_DIR, "index.min.js");
  const minBytes = getFileSize(minPath);

  // Gzipped sizes
  const rawData = readFileSync(jsPath);
  const minData = readFileSync(minPath);
  const gzipBytes = await gzipSize(rawData);
  const gzipMinBytes = await gzipSize(minData);

  console.log("\n=== SDK Bundle Size Report ===");
  console.log(
    `Raw (ESM):      ${rawBytes} bytes (${(rawBytes / 1024).toFixed(1)} KB)`,
  );
  console.log(
    `Minified:       ${minBytes} bytes (${(minBytes / 1024).toFixed(1)} KB)`,
  );
  console.log(
    `Gzipped:        ${gzipBytes} bytes (${(gzipBytes / 1024).toFixed(1)} KB)`,
  );
  console.log(
    `Minified+Gzipped: ${gzipMinBytes} bytes (${(gzipMinBytes / 1024).toFixed(1)} KB)`,
  );
  console.log(`\nTarget: < 30 KB gzipped`);
  console.log(`Status: ${gzipMinBytes < 30 * 1024 ? "PASS" : "FAIL"}`);

  // Cleanup
  rmSync(DIST_SIZE_DIR, { recursive: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
