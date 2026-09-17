#!/usr/bin/env node
// ReplayBug CLI — foundation build.
// Supports --version and --help only. Release and source-map commands
// arrive in a later block per the master specification.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function packageVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function printHelp() {
  console.log(`replaybug ${packageVersion()}`);
  console.log("");
  console.log("Developer observability for reproducible bugs.");
  console.log("");
  console.log("Usage:");
  console.log("  replaybug [options]");
  console.log("");
  console.log("Options:");
  console.log("  -V, --version    Print the CLI version");
  console.log("  -h, --help       Show this help message");
  console.log("");
  console.log("Future commands (not yet implemented):");
  console.log(
    "  releases create, sourcemaps upload, releases list, projects info",
  );
}

const args = new Set(process.argv.slice(2));

if (args.has("--version") || args.has("-V")) {
  console.log(packageVersion());
} else {
  printHelp();
}
