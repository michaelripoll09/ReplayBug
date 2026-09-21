/**
 * RS-07 binary entry: builds the commander program with the real
 * network client and scanner, then maps every failure to a friendly
 * stderr message and a non-zero exit — no stack traces unless
 * `REPLAYBUG_DEBUG=1`, and the token never appears in any output.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient } from "./client.js";
import { isDebugMode, CliError, formatCliError } from "./errors.js";
import { createProgram } from "./program.js";
import { scanSourcemapDirectory } from "./scanner.js";

function packageVersion(): string {
  // dist/bin.js runs one level below the package root, mirroring the
  // previous bin/replaybug.js layout (bin/ → ../package.json).
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  try {
    const program = createProgram({
      version: packageVersion(),
      createClient: (options) => createApiClient(options),
      scanDirectory: (root: string) => scanSourcemapDirectory(root),
    });
    await program.parseAsync(argv);
  } catch (error) {
    handleFatal(error);
  }
}

function handleFatal(error: unknown): void {
  if (isCommanderExit(error)) {
    // commander already printed help/version or an option error and set
    // the exit code itself (exitOverride is NOT used in the binary, so
    // this path only triggers for defensive completeness).
    if (error.exitCode !== 0) {
      process.exitCode = error.exitCode;
    }
    return;
  }
  if (error instanceof CliError) {
    console.error(formatCliError(error));
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("Error: an unexpected error occurred.");
  }
  if (isDebugMode() && error instanceof Error && error.stack !== undefined) {
    // Stacks never carry the token: it only exists in the Authorization
    // header value, which is never attached to an error object.
    console.error(error.stack);
  }
  process.exitCode = 1;
}

function isCommanderExit(error: unknown): error is { exitCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.") &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
  );
}

main().catch((error: unknown) => {
  handleFatal(error);
});
